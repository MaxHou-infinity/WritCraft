#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { createMarkdownTrashWorker, createMarkdownTrashWorkerForRoot } = require('../src/main/markdown-trash-worker');

const TEST_HELPER_TIMEOUT_MS = 5000;
let passed = 0;
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { process.exitCode = 1; console.error(`  ✗ ${label}: ${error.stack || error.message}`); }
}
function identity(target) { const stat = fs.lstatSync(target, { bigint: true }); return { dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode }; }
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function compile(scratch, defines = []) {
  const output = path.join(scratch, 'markdown-trash-helper');
  childProcess.execFileSync('xcrun', ['--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O0', ...defines, path.join(__dirname, '..', 'native', 'markdown-trash-helper.c'), '-o', output]);
  return output;
}
function rootFd(root) { return fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
async function close(worker) { const ended = worker.closed ? Promise.resolve() : once(worker.child, 'close'); worker.close(); await ended; }
function setup(scratch) {
  const root = path.join(scratch, 'project'); const trash = path.join(root, '.writcraft', 'trash');
  fs.mkdirSync(trash, { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(root, '.writcraft'), 0o700); fs.chmodSync(trash, 0o700); fs.mkdirSync(path.join(root, 'chapters'));
  const source = path.join(trash, 'entry.md'); fs.writeFileSync(source, 'original manuscript');
  const manifest = Buffer.from('{"schema":"writcraft.trash/v1","entries":["entry.md"]}\n'); fs.writeFileSync(path.join(trash, 'manifest.json'), manifest);
  const nextManifest = Buffer.from('{"schema":"writcraft.trash/v1","entries":[]}\n');
  return { root, trash, source, manifest, nextManifest };
}
function request(data) { return { sourceName: 'entry.md', target: 'chapters/restored.md', digest: sha('original manuscript'), identity: identity(data.source), manifestDigest: sha(data.manifest), nextManifest: data.nextManifest }; }
function trashSetup(scratch) {
  const root = path.join(scratch, 'project'); const trash = path.join(root, '.writcraft', 'trash'); const source = path.join(root, 'chapters', 'draft.md');
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.mkdirSync(trash, { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(root, '.writcraft'), 0o700); fs.chmodSync(trash, 0o700); fs.writeFileSync(source, 'draft manuscript');
  const manifest = Buffer.from('{"schema":"writcraft.trash/v1","entries":[]}\n'); const nextManifest = Buffer.from('{"schema":"writcraft.trash/v1","entries":["entry.md"]}\n');
  fs.writeFileSync(path.join(trash, 'manifest.json'), manifest); return { root, trash, source, manifest, nextManifest };
}
function trashRequest(data) { return { source: 'chapters/draft.md', targetName: 'entry.md', digest: sha('draft manuscript'), identity: identity(data.source), manifestDigest: sha(data.manifest), nextManifest: data.nextManifest }; }
function trashStatusRequest(data) { return { ...trashRequest(data), operation: 'T' }; }
function firstTrashSetup(scratch) {
  const root = path.join(scratch, 'project'); const source = path.join(root, 'first.md'); fs.mkdirSync(root); fs.writeFileSync(source, 'first manuscript');
  const nextManifest = Buffer.from('{"schema":"writcraft.trash/v1","entries":["first.md"]}\n');
  return { root, source, nextManifest };
}

async function run() {
  console.log('\nWritCraft native Markdown trash worker verification');
  await check('uses the originally opened project root after its pathname is replaced', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = setup(scratch); const helper = compile(scratch);
    const worker = createMarkdownTrashWorkerForRoot(data.root, identity(data.root), { helperPath: helper, beforeRequest() {
      fs.renameSync(data.root, `${data.root}-original`); fs.mkdirSync(data.root); fs.mkdirSync(path.join(data.root, '.writcraft', 'trash'), { recursive: true }); fs.writeFileSync(path.join(data.root, '.writcraft', 'trash', 'manifest.json'), 'attacker');
    }});
    try { const listed = await worker.list(); assert.strictEqual(listed.manifest.toString(), data.manifest.toString()); assert.strictEqual(fs.readFileSync(path.join(data.root, '.writcraft', 'trash', 'manifest.json'), 'utf8'), 'attacker'); }
    finally { await close(worker); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  await check('reports recovery required when an exclusive final-target race occurs', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = setup(scratch); const helper = compile(scratch, ['-DWRITCRAFT_TEST_TARGET_RACE']); const fd = rootFd(data.root); const worker = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: helper });
    try { const result = await worker.restore(request(data)); assert.deepStrictEqual(result, { state: 'RECOVERY_REQUIRED', reason: 'UNKNOWN' }); assert.strictEqual(fs.readFileSync(path.join(data.root, 'chapters', 'restored.md'), 'utf8'), 'race'); assert(!fs.existsSync(data.source)); assert(fs.readdirSync(data.trash).some(name => name.startsWith('.writcraft-md-restore-'))); }
    finally { await close(worker); fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  await check('reconciles a committed restore after the helper loses its success response', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = setup(scratch); const helper = compile(scratch, ['-DWRITCRAFT_TEST_DROP_COMMITTED_RESPONSE']); const fd = rootFd(data.root); const first = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: helper, timeoutMs: TEST_HELPER_TIMEOUT_MS });
    const restore = request(data);
    try {
      await assert.rejects(first.restore(restore), error => error?.code === 'MARKDOWN_TRASH_RECOVERY_REQUIRED');
      if (!first.closed) await close(first);
      const second = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch), timeoutMs: TEST_HELPER_TIMEOUT_MS });
      try { assert.deepStrictEqual(await second.restore(restore), { state: 'COMMITTED', reason: 'NONE' }); assert.strictEqual(fs.readFileSync(path.join(data.root, 'chapters', 'restored.md'), 'utf8'), 'original manuscript'); assert.strictEqual(fs.readFileSync(path.join(data.trash, 'manifest.json'), 'utf8'), data.nextManifest.toString()); }
      finally { await close(second); }
    } finally { fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  await check('returns a bounded raw manifest snapshot and rejects malformed restore requests before write', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = setup(scratch); const fd = rootFd(data.root); const worker = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch) });
    try { const listed = await worker.list(); assert.strictEqual(listed.digest, sha(data.manifest)); await assert.rejects(worker.restore({}), error => error?.code === 'MARKDOWN_TRASH_PROTOCOL'); assert.strictEqual(fs.readFileSync(data.source, 'utf8'), 'original manuscript'); }
    finally { await close(worker); fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  await check('fails closed when a source ancestor is replaced after Main captured its identity', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = trashSetup(scratch); const fd = rootFd(data.root); const worker = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch), beforeRequest({ kind }) {
      if (kind === 'trash') { fs.renameSync(path.join(data.root, 'chapters'), path.join(data.root, 'chapters-original')); fs.mkdirSync(path.join(data.root, 'chapters')); fs.writeFileSync(path.join(data.root, 'chapters', 'draft.md'), 'attacker'); }
    }});
    try { assert.deepStrictEqual(await worker.trash(trashRequest(data)), { state: 'UNCOMMITTED', reason: 'SOURCE_STALE' }); assert.strictEqual(fs.readFileSync(path.join(data.root, 'chapters', 'draft.md'), 'utf8'), 'attacker'); assert.strictEqual(fs.readFileSync(path.join(data.root, 'chapters-original', 'draft.md'), 'utf8'), 'draft manuscript'); }
    finally { await close(worker); fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  await check('reports recovery required when trash target appears at the exclusive publish boundary', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = trashSetup(scratch); const fd = rootFd(data.root); const worker = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch, ['-DWRITCRAFT_TEST_TRASH_TARGET_RACE']) });
    try { assert.deepStrictEqual(await worker.trash(trashRequest(data)), { state: 'RECOVERY_REQUIRED', reason: 'UNKNOWN' }); assert.strictEqual(fs.readFileSync(path.join(data.trash, 'entry.md'), 'utf8'), 'race'); assert(!fs.existsSync(data.source)); }
    finally { await close(worker); fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  await check('reconciles a committed trash after its success response is lost', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = trashSetup(scratch); const fd = rootFd(data.root); const requestValue = trashRequest(data); const statusValue = { ...requestValue, operation: 'T' }; const first = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch, ['-DWRITCRAFT_TEST_DROP_TRASH_COMMITTED_RESPONSE']), timeoutMs: TEST_HELPER_TIMEOUT_MS });
    try { await assert.rejects(first.trash(requestValue), error => error?.code === 'MARKDOWN_TRASH_RECOVERY_REQUIRED'); if (!first.closed) await close(first); const second = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch), timeoutMs: TEST_HELPER_TIMEOUT_MS }); try { assert.deepStrictEqual(await second.status(statusValue), { state: 'COMMITTED', reason: 'NONE' }); assert.deepStrictEqual(await second.reconcile(), { state: 'COMMITTED' }); assert.strictEqual(fs.readFileSync(path.join(data.trash, 'entry.md'), 'utf8'), 'draft manuscript'); assert.strictEqual(fs.readFileSync(path.join(data.trash, 'manifest.json'), 'utf8'), data.nextManifest.toString()); } finally { await close(second); } }
    finally { fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  await check('binds an inspect digest to one stable fd-relative file identity', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = trashSetup(scratch); const fd = rootFd(data.root); const steady = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch) });
    try { const inspected = await steady.inspect('chapters/draft.md', 1024); assert.strictEqual(inspected.ok, true); assert.strictEqual(inspected.digest, sha('draft manuscript')); assert.deepStrictEqual(inspected.identity, (() => { const value = identity(data.source); return { dev: value.dev, ino: value.ino, size: value.size }; })()); }
    finally { await close(steady); }
    const drifting = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch, ['-DWRITCRAFT_TEST_INSPECT_DRIFT']) });
    try { assert.deepStrictEqual(await drifting.inspect('chapters/draft.md', 1024), { ok: false, reason: 'SOURCE_STALE' }); assert.strictEqual(fs.readFileSync(data.source, 'utf8'), 'drift'); }
    finally { await close(drifting); fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  await check('bootstraps the first trash directory and publishes an ABSENT-M0 manifest transition', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = firstTrashSetup(scratch); const fd = rootFd(data.root); const worker = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch) });
    const requestValue = { source: 'first.md', targetName: 'first-entry.md', digest: sha('first manuscript'), identity: identity(data.source), manifestDigest: 'ABSENT', nextManifest: data.nextManifest };
    try { assert.deepStrictEqual(await worker.trash(requestValue), { state: 'COMMITTED', reason: 'NONE' }); assert.strictEqual(fs.readFileSync(path.join(data.root, '.writcraft', 'trash', 'first-entry.md'), 'utf8'), 'first manuscript'); assert.strictEqual(fs.readFileSync(path.join(data.root, '.writcraft', 'trash', 'manifest.json'), 'utf8'), data.nextManifest.toString()); }
    finally { await close(worker); fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  await check('auto-reconciles owned T journals after P, Q, and D crash states without a reconstructed request', async () => {
    for (const [marker, expected] of [['-DWRITCRAFT_TEST_CRASH_T_P', 'UNCOMMITTED'], ['-DWRITCRAFT_TEST_CRASH_T_Q', 'UNCOMMITTED'], ['-DWRITCRAFT_TEST_CRASH_T_D', 'COMMITTED']]) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = trashSetup(scratch); const fd = rootFd(data.root); const requestValue = trashRequest(data);
      const first = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch, [marker]), timeoutMs: TEST_HELPER_TIMEOUT_MS });
      try { await assert.rejects(first.trash(requestValue), error => error?.code === 'MARKDOWN_TRASH_RECOVERY_REQUIRED'); if (!first.closed) await close(first); const second = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch), timeoutMs: TEST_HELPER_TIMEOUT_MS }); try { assert.deepStrictEqual(await second.reconcile(), { state: expected }); if (expected === 'UNCOMMITTED') { assert.strictEqual(fs.readFileSync(data.source, 'utf8'), 'draft manuscript'); assert(!fs.existsSync(path.join(data.trash, 'entry.md'))); assert.strictEqual(fs.readFileSync(path.join(data.trash, 'manifest.json'), 'utf8'), data.manifest.toString()); } else { assert.strictEqual(fs.readFileSync(path.join(data.trash, 'entry.md'), 'utf8'), 'draft manuscript'); assert.strictEqual(fs.readFileSync(path.join(data.trash, 'manifest.json'), 'utf8'), data.nextManifest.toString()); } } finally { await close(second); } }
      finally { fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
    }
  });
  await check('does not publish T or R through parent descriptors detached from the bound project tree', async () => {
    const scratchT = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const dataT = trashSetup(scratchT); const fdT = rootFd(dataT.root); const workerT = createMarkdownTrashWorker({ rootFd: fdT, expectedRootIdentity: identity(dataT.root), helperPath: compile(scratchT, ['-DWRITCRAFT_TEST_T_ANCESTOR_SWAP']) });
    try { assert.deepStrictEqual(await workerT.trash(trashRequest(dataT)), { state: 'RECOVERY_REQUIRED', reason: 'UNKNOWN' }); assert.strictEqual(fs.readFileSync(path.join(dataT.root, 'chapters-original-test', 'draft.md'), 'utf8'), 'draft manuscript'); assert(!fs.existsSync(path.join(dataT.trash, 'entry.md'))); }
    finally { await close(workerT); fs.closeSync(fdT); fs.rmSync(scratchT, { recursive: true, force: true }); }
    const scratchR = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const dataR = setup(scratchR); const fdR = rootFd(dataR.root); const workerR = createMarkdownTrashWorker({ rootFd: fdR, expectedRootIdentity: identity(dataR.root), helperPath: compile(scratchR, ['-DWRITCRAFT_TEST_R_ANCESTOR_SWAP']) });
    try { assert.deepStrictEqual(await workerR.restore(request(dataR)), { state: 'RECOVERY_REQUIRED', reason: 'UNKNOWN' }); assert.strictEqual(fs.readFileSync(dataR.source, 'utf8'), 'original manuscript'); assert(!fs.existsSync(path.join(dataR.root, 'chapters', 'restored.md'))); }
    finally { await close(workerR); fs.closeSync(fdR); fs.rmSync(scratchR, { recursive: true, force: true }); }
  });
  await check('rejects an existing non-private trash directory instead of treating it as CLEAR', async () => {
    for (const target of ['meta', 'trash']) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = trashSetup(scratch);
      fs.chmodSync(target === 'meta' ? path.join(data.root, '.writcraft') : data.trash, 0o755);
      const fd = rootFd(data.root); const worker = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch) });
      try {
        assert.deepStrictEqual(await worker.reconcile(), { state: 'RECOVERY_REQUIRED' });
        assert.deepStrictEqual(await worker.trash(trashRequest(data)), { state: 'UNCOMMITTED', reason: 'REQUEST_INVALID' });
        assert.strictEqual(fs.readFileSync(data.source, 'utf8'), 'draft manuscript');
      } finally { await close(worker); fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
    }
  });
  await check('auto-reconciles owned R journals after P, Q, and D crash states without assuming a preexisting M1', async () => {
    for (const [marker, expected] of [['-DWRITCRAFT_TEST_CRASH_R_P', 'UNCOMMITTED'], ['-DWRITCRAFT_TEST_CRASH_R_Q', 'UNCOMMITTED'], ['-DWRITCRAFT_TEST_CRASH_R_D', 'COMMITTED']]) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = setup(scratch); const fd = rootFd(data.root); const restoreValue = request(data);
      const first = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch, [marker]), timeoutMs: TEST_HELPER_TIMEOUT_MS });
      try { await assert.rejects(first.restore(restoreValue), error => error?.code === 'MARKDOWN_TRASH_RECOVERY_REQUIRED'); if (!first.closed) await close(first); const second = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch), timeoutMs: TEST_HELPER_TIMEOUT_MS }); try { assert.deepStrictEqual(await second.reconcile(), { state: expected }); if (expected === 'UNCOMMITTED') { assert.strictEqual(fs.readFileSync(data.source, 'utf8'), 'original manuscript'); assert(!fs.existsSync(path.join(data.root, 'chapters', 'restored.md'))); assert.strictEqual(fs.readFileSync(path.join(data.trash, 'manifest.json'), 'utf8'), data.manifest.toString()); } else { assert.strictEqual(fs.readFileSync(path.join(data.root, 'chapters', 'restored.md'), 'utf8'), 'original manuscript'); assert.strictEqual(fs.readFileSync(path.join(data.trash, 'manifest.json'), 'utf8'), data.nextManifest.toString()); } } finally { await close(second); } }
      finally { fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
    }
  });
  await check('reconciles journal state-lag after each T/R rename before its journal state is advanced', async () => {
    const cases = [
      ['T', '-DWRITCRAFT_TEST_CRASH_T_AFTER_SOURCE_RENAME', 'UNCOMMITTED'], ['T', '-DWRITCRAFT_TEST_CRASH_T_AFTER_TARGET_RENAME', 'COMMITTED'], ['T', '-DWRITCRAFT_TEST_CRASH_T_AFTER_MANIFEST_PUBLISH', 'COMMITTED'],
      ['R', '-DWRITCRAFT_TEST_CRASH_R_AFTER_SOURCE_RENAME', 'UNCOMMITTED'], ['R', '-DWRITCRAFT_TEST_CRASH_R_AFTER_TARGET_RENAME', 'COMMITTED'], ['R', '-DWRITCRAFT_TEST_CRASH_R_AFTER_MANIFEST_PUBLISH', 'COMMITTED'],
    ];
    for (const [kind, marker, expected] of cases) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = kind === 'T' ? trashSetup(scratch) : setup(scratch); const fd = rootFd(data.root);
      const operation = kind === 'T' ? trashRequest(data) : request(data); const first = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch, [marker]), timeoutMs: TEST_HELPER_TIMEOUT_MS });
      try { await first.ready(); first.timeoutMs = 100; await assert.rejects(kind === 'T' ? first.trash(operation) : first.restore(operation), error => error?.code === 'MARKDOWN_TRASH_RECOVERY_REQUIRED'); if (!first.closed) await close(first); const second = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch), timeoutMs: TEST_HELPER_TIMEOUT_MS }); try { assert.deepStrictEqual(await second.reconcile(), { state: expected }); } finally { await close(second); } }
      finally { fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
    }
  });
  await check('fails recovery rollback when the named source parent is replaced after entry validation', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = trashSetup(scratch); const fd = rootFd(data.root);
    const first = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch, ['-DWRITCRAFT_TEST_CRASH_T_Q']), timeoutMs: TEST_HELPER_TIMEOUT_MS });
    try {
      await first.ready(); first.timeoutMs = 100;
      await assert.rejects(first.trash(trashRequest(data)), error => error?.code === 'MARKDOWN_TRASH_RECOVERY_REQUIRED');
      if (!first.closed) await close(first);
      const second = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch, ['-DWRITCRAFT_TEST_RECOVER_ROLLBACK_PARENT_SWAP']), timeoutMs: TEST_HELPER_TIMEOUT_MS });
      try {
        assert.deepStrictEqual(await second.reconcile(), { state: 'RECOVERY_REQUIRED' });
        assert(!fs.existsSync(path.join(data.root, 'chapters', 'draft.md')));
        assert(!fs.existsSync(path.join(data.root, 'chapters-recovery-original-test', 'draft.md')));
        assert.strictEqual(fs.readFileSync(path.join(data.trash, fs.readdirSync(data.trash).find(name => name.startsWith('.writcraft-md-source-'))), 'utf8'), 'draft manuscript');
      } finally { await close(second); }
    } finally { fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  await check('fails recovery roll-forward when the named target parent is replaced after entry validation', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = setup(scratch); const fd = rootFd(data.root);
    const first = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch, ['-DWRITCRAFT_TEST_CRASH_R_D']), timeoutMs: TEST_HELPER_TIMEOUT_MS });
    try {
      await first.ready(); first.timeoutMs = 100;
      await assert.rejects(first.restore(request(data)), error => error?.code === 'MARKDOWN_TRASH_RECOVERY_REQUIRED');
      if (!first.closed) await close(first);
      const manifestBefore = fs.readFileSync(path.join(data.trash, 'manifest.json'));
      const second = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch, ['-DWRITCRAFT_TEST_RECOVER_ROLLFORWARD_PARENT_SWAP']), timeoutMs: TEST_HELPER_TIMEOUT_MS });
      try {
        assert.deepStrictEqual(await second.reconcile(), { state: 'RECOVERY_REQUIRED' });
        assert(!fs.existsSync(path.join(data.root, 'chapters', 'restored.md')));
        assert.strictEqual(fs.readFileSync(path.join(data.root, 'chapters-recovery-original-test', 'restored.md'), 'utf8'), 'original manuscript');
        assert.strictEqual(fs.readFileSync(path.join(data.trash, 'manifest.json')).equals(manifestBefore), true);
      } finally { await close(second); }
    } finally { fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  await check('does not delete a same-schema journal replacement with a different inode', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = trashSetup(scratch); const fd = rootFd(data.root); const first = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch, ['-DWRITCRAFT_TEST_CRASH_T_P']), timeoutMs: TEST_HELPER_TIMEOUT_MS });
    try { await first.ready(); first.timeoutMs = 100; await assert.rejects(first.trash(trashRequest(data)), error => error?.code === 'MARKDOWN_TRASH_RECOVERY_REQUIRED'); if (!first.closed) await close(first); const journal = fs.readdirSync(data.trash).find(name => name.startsWith('.writcraft-md-restore-')); assert(journal); const replacement = fs.readFileSync(path.join(data.trash, journal)); fs.renameSync(path.join(data.trash, journal), path.join(data.trash, `${journal}.original`)); fs.writeFileSync(path.join(data.trash, journal), replacement, { mode: 0o600 }); const replacedIdentity = identity(path.join(data.trash, journal)); const second = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch), timeoutMs: TEST_HELPER_TIMEOUT_MS }); try { assert.deepStrictEqual(await second.reconcile(), { state: 'RECOVERY_REQUIRED' }); const after = identity(path.join(data.trash, journal)); assert.strictEqual(after.ino, replacedIdentity.ino); assert.strictEqual(fs.readFileSync(path.join(data.trash, journal)).equals(replacement), true); } finally { await close(second); } }
    finally { fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  await check('rejects an in-place journal rewrite whose canonical body no longer matches its receipt digest', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = trashSetup(scratch); const fd = rootFd(data.root); const first = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch, ['-DWRITCRAFT_TEST_CRASH_T_P']), timeoutMs: TEST_HELPER_TIMEOUT_MS });
    try {
      await first.ready(); first.timeoutMs = 100;
      await assert.rejects(first.trash(trashRequest(data)), error => error?.code === 'MARKDOWN_TRASH_RECOVERY_REQUIRED');
      if (!first.closed) await close(first);
      const journalName = fs.readdirSync(data.trash).find(name => name.startsWith('.writcraft-md-restore-')); assert(journalName);
      const journalPath = path.join(data.trash, journalName); const before = identity(journalPath); const bytes = fs.readFileSync(journalPath);
      bytes[0] = bytes[0] === 0x50 ? 0x51 : 0x50;
      const journalFd = fs.openSync(journalPath, 'r+');
      try { fs.writeSync(journalFd, bytes, 0, bytes.length, 0); fs.fsyncSync(journalFd); } finally { fs.closeSync(journalFd); }
      assert.strictEqual(identity(journalPath).ino, before.ino);
      const second = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch), timeoutMs: TEST_HELPER_TIMEOUT_MS });
      try { assert.deepStrictEqual(await second.reconcile(), { state: 'RECOVERY_REQUIRED' }); assert.strictEqual(fs.readFileSync(journalPath).equals(bytes), true); }
      finally { await close(second); }
    } finally { fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  await check('does not accept a same-byte M1 manifest replacement as the committed artifact', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = trashSetup(scratch); const fd = rootFd(data.root); const first = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch, ['-DWRITCRAFT_TEST_CRASH_T_AFTER_MANIFEST_PUBLISH']), timeoutMs: TEST_HELPER_TIMEOUT_MS });
    try {
      await first.ready(); first.timeoutMs = 100;
      await assert.rejects(first.trash(trashRequest(data)), error => error?.code === 'MARKDOWN_TRASH_RECOVERY_REQUIRED');
      if (!first.closed) await close(first);
      const manifestPath = path.join(data.trash, 'manifest.json'); const replacement = fs.readFileSync(manifestPath);
      const originalInode = identity(manifestPath).ino; fs.renameSync(manifestPath, `${manifestPath}.original`);
      fs.writeFileSync(manifestPath, replacement, { mode: 0o600 }); const replacementInode = identity(manifestPath).ino;
      assert.notStrictEqual(replacementInode, originalInode);
      const second = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch), timeoutMs: TEST_HELPER_TIMEOUT_MS });
      try { assert.deepStrictEqual(await second.reconcile(), { state: 'RECOVERY_REQUIRED' }); assert.strictEqual(identity(manifestPath).ino, replacementInode); assert(fs.readdirSync(data.trash).some(name => name.startsWith('.writcraft-md-restore-'))); }
      finally { await close(second); }
    } finally { fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  await check('does not delete a same-byte qmanifest replacement after a committed rename', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-md-trash-')); const data = trashSetup(scratch); const fd = rootFd(data.root); const first = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch, ['-DWRITCRAFT_TEST_CRASH_T_AFTER_MANIFEST_PUBLISH']), timeoutMs: TEST_HELPER_TIMEOUT_MS });
    try {
      await first.ready(); first.timeoutMs = 100;
      await assert.rejects(first.trash(trashRequest(data)), error => error?.code === 'MARKDOWN_TRASH_RECOVERY_REQUIRED');
      if (!first.closed) await close(first);
      const qname = fs.readdirSync(data.trash).find(name => name.startsWith('.writcraft-md-oldmanifest-')); assert(qname);
      const qpath = path.join(data.trash, qname); const replacement = fs.readFileSync(qpath);
      const originalInode = identity(qpath).ino; fs.renameSync(qpath, `${qpath}.original`);
      fs.writeFileSync(qpath, replacement, { mode: 0o600 }); const replacementInode = identity(qpath).ino;
      assert.notStrictEqual(replacementInode, originalInode);
      const second = createMarkdownTrashWorker({ rootFd: fd, expectedRootIdentity: identity(data.root), helperPath: compile(scratch), timeoutMs: TEST_HELPER_TIMEOUT_MS });
      try { assert.deepStrictEqual(await second.reconcile(), { state: 'RECOVERY_REQUIRED' }); assert.strictEqual(identity(qpath).ino, replacementInode); assert(fs.readdirSync(data.trash).some(name => name.startsWith('.writcraft-md-restore-'))); }
      finally { await close(second); }
    } finally { fs.closeSync(fd); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  console.log(`\n${passed}/20 checks passed`); if (passed !== 20) process.exitCode = 1;
}
run();
