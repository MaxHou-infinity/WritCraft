#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nativeHelperBuild = require('../scripts/build-native-helper');
const evidenceSchema = require('../src/main/evidence-delivery-schema');
const bundleService = require('../src/main/snapshot-bundle');
const marked = require('../src/shared/marked.umd');
const snapshotImageTokenizer = require('../src/shared/snapshot-image-tokenizer');
const APP_VERSION = require('../package.json').version;

console.log('\nWritCraft snapshot storage native helper verification');

const SOURCE = path.join(__dirname, '..', 'native', 'snapshot-storage-helper.c');
const TRANSACTION_ID = `txn_${'1'.repeat(48)}`;
const SNAPSHOT_ID = `snapshot_${'2'.repeat(48)}`;
const STAGE_NAME = `stage-${'3'.repeat(64)}.wcsb`;
const FINAL_NAME = `bundle-${'4'.repeat(64)}.wcsb`;
const COMMITTED_AT = '2026-08-06T04:00:00.000Z';
const PROJECT_INSTANCE_ID = `instance_${'a'.repeat(24)}`;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function withScratch(fn) {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-helper-'));
  const scratch = fs.realpathSync(created);
  try {
    return fn(scratch);
  } finally {
    fs.rmSync(created, { recursive: true, force: true });
  }
}

function compileHelper(scratch, definitions = []) {
  const suffix = definitions.length === 0
    ? 'normal'
    : definitions.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const output = path.join(scratch, `snapshot-storage-helper-${suffix}`);
  childProcess.execFileSync('xcrun', [
    '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
    `-DWRITCRAFT_APP_VERSION=\"${APP_VERSION}\"`,
    ...definitions.map(definition => `-D${definition}`),
    SOURCE, '-o', output,
  ]);
  return output;
}

function createPrivateTree(project, controlMode = 0o700) {
  const root = path.join(project, '.writcraft', 'snapshots', 'v1');
  fs.mkdirSync(path.join(root, 'bundles'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'control'), { mode: controlMode });
  fs.mkdirSync(path.join(root, 'quarantine'), { mode: 0o700 });
  fs.chmodSync(path.join(project, '.writcraft'), 0o700);
  fs.chmodSync(path.join(project, '.writcraft', 'snapshots'), 0o700);
  fs.chmodSync(root, 0o700);
  fs.chmodSync(path.join(root, 'bundles'), 0o700);
  fs.chmodSync(path.join(root, 'control'), controlMode);
  fs.chmodSync(path.join(root, 'quarantine'), 0o700);
  return root;
}

function encodeHex(value) {
  return Buffer.from(value, 'utf8').toString('hex');
}

function opaqueCaptureId(prefix, transactionId, snapshotId, relativePath) {
  const preimage = Buffer.concat([
    Buffer.from(prefix, 'utf8'), Buffer.from([0]),
    Buffer.from(transactionId, 'utf8'), Buffer.from([0]),
    Buffer.from(snapshotId, 'utf8'), Buffer.from([0]),
    Buffer.from(relativePath, 'utf8'),
  ]);
  return `${prefix}${crypto.createHash('sha256').update(preimage).digest('hex')}`;
}

function statMode(value) {
  return Number(value.mode & 0o7777n);
}

function sealManifest(manifest) {
  manifest.fileRevisionSetDigest = evidenceSchema.createFileRevisionSetDigest(
    manifest.files.map(file => ({
      fileId: file.fileId,
      path: file.path,
      revision: file.revision,
      sha256: file.sha256,
    }))
  ).digest;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    manifest.snapshotManifestDigest = evidenceSchema.digestObject(
      evidenceSchema.SCHEMAS.SNAPSHOT,
      manifest,
      'snapshotManifestDigest'
    );
    const length = Buffer.byteLength(evidenceSchema.canonicalJson(manifest), 'utf8');
    if (manifest.budgets.observed.manifestBytes === length) break;
    manifest.budgets.observed.manifestBytes = length;
  }
  manifest.snapshotManifestDigest = evidenceSchema.digestObject(
    evidenceSchema.SCHEMAS.SNAPSHOT,
    manifest,
    'snapshotManifestDigest'
  );
  return manifest;
}

function createBundleFixture(snapshotId = SNAPSHOT_ID) {
  const content = Buffer.from('# Stage A1\n\n严格 UTF-8 😀\n', 'utf8');
  const header = {
    schema: evidenceSchema.SCHEMAS.SNAPSHOT_BUNDLE_ENTRY,
    fileId: 'file_stage_a1',
    path: 'chapters/a1.md',
    kind: 'markdown',
    byteLength: content.length,
    sha256: bundleService.digestBytes(content),
  };
  const file = {
    fileId: header.fileId,
    path: header.path,
    kind: header.kind,
    mode: 0o600,
    byteLength: content.length,
    sha256: header.sha256,
    revision: header.sha256.slice(7),
    ancestorIdentityDigest: `sha256:${'5'.repeat(64)}`,
    sourceObjectIdentityDigest: `sha256:${'6'.repeat(64)}`,
    bundleObjectDigest: bundleService.bundleObjectDigest(
      Buffer.from(evidenceSchema.canonicalJson(header), 'utf8'),
      content
    ),
    references: [],
  };
  const manifest = sealManifest({
    schema: evidenceSchema.SCHEMAS.SNAPSHOT,
    projectInstanceId: `instance_${'a'.repeat(24)}`,
    snapshotId,
    createdAt: COMMITTED_AT,
    creationMutationGeneration: 11,
    rootIdentityDigest: `sha256:${'7'.repeat(64)}`,
    files: [file],
    fileRevisionSetDigest: null,
    budgets: {
      limits: { ...bundleService.SNAPSHOT_LIMITS },
      observed: {
        markdownFiles: 1,
        imageFiles: 0,
        totalItems: 1,
        markdownBytes: content.length,
        imageBytes: 0,
        snapshotBytes: content.length,
        manifestBytes: 0,
        privateMetadataBytes: 0,
      },
    },
    producerVersion: '0.3.0-stage-a1',
    snapshotManifestDigest: null,
  });
  const created = bundleService.createBundle(manifest, [{ fileId: file.fileId, content }]);
  return { ...created, manifest };
}

function writeCommands(transactionId, content) {
  const result = [];
  for (let offset = 0; offset < content.length; offset += 64 * 1024) {
    result.push(`W\t${transactionId}\t${content.subarray(offset, offset + 64 * 1024).toString('hex')}`);
  }
  return result;
}

function resealOuterPayload(bundle) {
  const result = Buffer.from(bundle);
  const payloadEnd = result.length - 40;
  crypto.createHash('sha256').update(result.subarray(0, payloadEnd)).digest().copy(result, payloadEnd);
  return result;
}

function protocol({ project, fixture = createBundleFixture(), publish = false }) {
  return [
    `P\t${encodeHex(project)}`,
    'D',
    `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${fixture.bundle.length}`,
    ...writeCommands(TRANSACTION_ID, fixture.bundle),
    `F\t${TRANSACTION_ID}\t${fixture.manifest.snapshotManifestDigest}`,
    publish ? `A\t${TRANSACTION_ID}\t${FINAL_NAME}\t${COMMITTED_AT}` : `C\t${TRANSACTION_ID}`,
    'X',
    '',
  ].join('\n');
}

function runHelper(helper, project, input) {
  const trustedRootFd = fs.openSync('/', fs.constants.O_RDONLY);
  try {
    return childProcess.spawnSync(helper, [], {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe', trustedRootFd],
    });
  } finally {
    fs.closeSync(trustedRootFd);
  }
}

function runLateTerminalMutation(helper, project, input, syncName, mutation) {
  const driver = String.raw`
    const childProcess = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const [helper, project, input64, syncName, mutation] = process.argv.slice(1);
    const sync = path.join(project, 'sync');
    fs.mkdirSync(sync, { mode: 0o700 });
    const rootFd = fs.openSync('/', fs.constants.O_RDONLY);
    const child = childProcess.spawn(helper, [], {
      stdio: ['pipe', 'pipe', 'pipe', rootFd],
      env: { ...process.env, WRITCRAFT_TEST_SYNC_DIR: sync },
    });
    fs.closeSync(rootFd);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    const closed = new Promise(resolve => child.on('close', (status, signal) =>
      resolve({ status, signal, stdout, stderr })));
    child.stdin.end(Buffer.from(input64, 'base64'));
    async function waitFor(target) {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(target)) {
        if (Date.now() >= deadline) throw new Error('sync timeout');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    (async () => {
      const ready = path.join(sync, syncName + '.ready');
      await waitFor(ready);
      const privateRoot = path.join(project, '.writcraft', 'snapshots', 'v1');
      if (mutation === 'receipt-delete' || mutation === 'receipt-rewrite' ||
          mutation === 'receipt-replace' || mutation === 'receipt-duplicate') {
        const control = path.join(privateRoot, 'control');
        const receipt = fs.readdirSync(control).find(name => name.startsWith('receipt-'));
        if (!receipt) throw new Error('receipt missing');
        const target = path.join(control, receipt);
        if (mutation === 'receipt-delete') fs.unlinkSync(target);
        else if (mutation === 'receipt-rewrite') {
          const fd = fs.openSync(target, 'r+');
          fs.writeSync(fd, Buffer.from('!'), 0, 1, 1);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
        } else if (mutation === 'receipt-replace') {
          const exact = fs.readFileSync(target);
          fs.renameSync(target, target + '.old');
          fs.writeFileSync(target, exact, { mode: 0o600, flag: 'wx' });
        } else {
          const exact = fs.readFileSync(target);
          const duplicate = path.join(control, 'receipt-' + 'f'.repeat(64) + '.json');
          fs.writeFileSync(duplicate, exact, { mode: 0o600, flag: 'wx' });
          const fd = fs.openSync(control, 'r');
          fs.fsyncSync(fd);
          fs.closeSync(fd);
        }
      } else if (mutation === 'leaf-replace' || mutation === 'leaf-delete' ||
          mutation === 'leaf-rewrite') {
        const bundles = path.join(privateRoot, 'bundles');
        const name = fs.readdirSync(bundles).find(value => value.startsWith('bundle-'));
        if (!name) throw new Error('bundle missing');
        const target = path.join(bundles, name);
        if (mutation === 'leaf-delete') fs.unlinkSync(target);
        else if (mutation === 'leaf-rewrite') {
          const fd = fs.openSync(target, 'r+');
          fs.writeSync(fd, Buffer.from([0x00]), 0, 1, 0);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
        } else {
          const exact = fs.readFileSync(target);
          fs.renameSync(target, target + '.old');
          fs.writeFileSync(target, exact, { mode: 0o600, flag: 'wx' });
          const fd = fs.openSync(target, 'r');
          fs.fsyncSync(fd);
          fs.closeSync(fd);
        }
      }
      fs.writeFileSync(path.join(sync, syncName + '.release'), '', { flag: 'wx' });
      process.stdout.write(JSON.stringify(await closed));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = childProcess.spawnSync(process.execPath, [
    '-e', driver, helper, project, Buffer.from(input).toString('base64'), syncName, mutation,
  ], { encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runAfterKMutation(helper, project, commands, mutation) {
  const driver = String.raw`
    const childProcess = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const [helper, project, encodedCommands, mutation] = process.argv.slice(1);
    const rootFd = fs.openSync('/', fs.constants.O_RDONLY);
    const child = childProcess.spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe', rootFd] });
    let stdout = '';
    let stderr = '';
    let mutated = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (!mutated && stdout.includes('\nK\tOK\t')) {
        mutated = true;
        if (mutation === 'same-inode') {
          const target = path.join(project, 'chapter.md');
          const before = fs.statSync(target);
          const fd = fs.openSync(target, 'r+');
          fs.writeSync(fd, Buffer.from('# changed bytes!\n'), 0, 16, 0);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          fs.utimesSync(target, before.atime, before.mtime);
        } else if (mutation === 'ancestor') {
          fs.renameSync(path.join(project, 'chapters'), path.join(project, 'chapters-old'));
          fs.mkdirSync(path.join(project, 'chapters'));
          fs.writeFileSync(path.join(project, 'chapters', 'chapter.md'), '# original\n', { mode: 0o600 });
        } else if (mutation === 'root') {
          const old = project + '-old';
          fs.renameSync(project, old);
          fs.mkdirSync(project);
        }
        child.stdin.write('B\t${TRANSACTION_ID}\nX\n');
        child.stdin.end();
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      fs.closeSync(rootFd);
      process.stdout.write(JSON.stringify({ status, signal, stdout, stderr, mutated }));
    });
    child.stdin.write(Buffer.from(encodedCommands, 'base64').toString('utf8'));
  `;
  const input = `${commands.join('\n')}\n`;
  const result = childProcess.spawnSync(process.execPath, [
    '-e', driver, helper, project, Buffer.from(input).toString('base64'), mutation,
  ], { encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function reconcileProtocol(project, extra = []) {
  return [
    `P\t${encodeHex(project)}`,
    'D',
    `R\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${FINAL_NAME}\t${COMMITTED_AT}`,
    ...extra,
    '',
  ].join('\n');
}

function productionCaptureProtocol(project, extraFields = []) {
  return [...productionCaptureCommands(project, extraFields), 'X', ''].join('\n');
}

function productionCaptureCommands(project, extraFields = []) {
  return [
    `P\t${encodeHex(project)}`,
    'D',
    [
      'G', TRANSACTION_ID, PROJECT_INSTANCE_ID, SNAPSHOT_ID, '17', '23', COMMITTED_AT,
      ...extraFields,
    ].join('\t'),
  ];
}

function sealedCandidates(stdout) {
  const lines = stdout.trim().split('\n');
  const terminal = lines.find(line => line.startsWith(`G\tOK\t${TRANSACTION_ID}\t`));
  assert(terminal, stdout);
  const terminalFields = terminal.split('\t');
  const captureDigest = terminalFields[4];
  return lines.filter(line => line.startsWith('G\tMARKDOWN\t')).map(line => {
    const fields = line.split('\t');
    const chunks = lines.filter(candidateLine =>
      candidateLine.startsWith(`G\tBYTES\t${fields[2]}\t${fields[3]}\t`)
    ).sort((left, right) => Number(left.split('\t')[4]) - Number(right.split('\t')[4]));
    return {
      candidateId: fields[3],
      captureDigest,
      fileId: fields[4],
      revision: fields[7],
      markdownBytes: Buffer.concat(chunks.map(chunk => Buffer.from(chunk.split('\t')[5], 'hex'))),
    };
  });
}

function tokenPassCommands(pass, overrides = {}) {
  const api = snapshotImageTokenizer.createAdapter({
    marked,
    sha256Bytes: bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
  });
  const value = { ...pass, ...overrides };
  const canonical = Buffer.from(api.canonicalJson(value), 'utf8');
  return [
    `T\t${TRANSACTION_ID}\t${canonical.length}`,
    ...writeCommands(TRANSACTION_ID, canonical).map(command => `U${command.slice(1)}`),
    `K\t${TRANSACTION_ID}`,
  ];
}

function digestBasename(prefix, value, suffix) {
  return `${prefix}${crypto.createHash('sha256').update(value).digest('hex')}${suffix}`;
}

test('registers the helper in the native build allowlist', () => {
  assert.deepStrictEqual(nativeHelperBuild.NATIVE_HELPERS.snapshotStorage, {
    sourceName: 'snapshot-storage-helper.c',
    outputName: 'snapshot-storage-helper',
  });
  assert.strictEqual(nativeHelperBuild.APP_VERSION, APP_VERSION);
  assert.ok(nativeHelperBuild.BUILD_RECIPE.arguments.includes(
    `-DWRITCRAFT_APP_VERSION=\"${APP_VERSION}\"`
  ));
});

test('refuses a native build whose exact package version was not injected', () =>
  withScratch(scratch => {
    const output = path.join(scratch, 'missing-version-helper');
    assert.throws(() => childProcess.execFileSync('xcrun', [
      '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
      SOURCE, '-o', output,
    ], { stdio: 'pipe' }), error => {
      assert.match(String(error.stderr), /WRITCRAFT_APP_VERSION must be injected/);
      return true;
    });
    assert.strictEqual(fs.existsSync(output), false);
  })
);

test('production G seals root-bound Markdown bytes and issues opaque image candidates without private writes', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const markdown = Buffer.from('# Native capture\n\nSame scan bytes.\n', 'utf8');
    fs.writeFileSync(path.join(project, 'chapter.md'), markdown, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(project, 'figure.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      mode: 0o600,
      flag: 'wx',
    });
    const result = runHelper(helper, project, productionCaptureProtocol(project));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const lines = result.stdout.trim().split('\n');
    const markdownFields = lines[2].split('\t');
    assert.match(markdownFields[2], /^capture_[a-f0-9]{64}$/);
    assert.match(markdownFields[3], /^candidate_[a-f0-9]{64}$/);
    assert.match(markdownFields[4], /^file_[a-f0-9]{64}$/);
    assert.strictEqual(Number(markdownFields[5]), markdown.length);
    assert.strictEqual(markdownFields[6], `sha256:${crypto.createHash('sha256').update(markdown).digest('hex')}`);
    assert.strictEqual(markdownFields[7], markdownFields[6].slice(7));
    assert.strictEqual(result.stdout.includes('chapter.md'), false);
    assert.strictEqual(result.stdout.includes(Buffer.from('chapter.md').toString('hex')), false);
    const bytesFields = lines[3].split('\t');
    assert.deepStrictEqual(bytesFields.slice(0, 5), [
      'G', 'BYTES', markdownFields[2], markdownFields[3], '0',
    ]);
    assert.ok(Buffer.from(bytesFields[5], 'hex').equals(markdown));
    assert.match(lines[4], new RegExp(
      `^G\\tOK\\t${TRANSACTION_ID}\\t${markdownFields[2]}` +
      `\\tsha256:[a-f0-9]{64}\\t1\\t${markdown.length}$`
    ));
    const rootStat = fs.statSync(project, { bigint: true });
    const fileStat = fs.statSync(path.join(project, 'chapter.md'), { bigint: true });
    const rootIdentityDigest = evidenceSchema.digestObject('writcraft.root-identity/v1', {
      schema: 'writcraft.root-identity/v1',
      dev: String(rootStat.dev),
      ino: String(rootStat.ino),
      uid: Number(rootStat.uid),
      mode: statMode(rootStat),
    });
    const ancestorIdentityDigest = evidenceSchema.digestObject('writcraft.ancestor-identity/v1', {
      schema: 'writcraft.ancestor-identity/v1',
      components: [],
    });
    const contentSha256 = markdownFields[6];
    const sourceObjectIdentityDigest = evidenceSchema.digestObject('writcraft.object-identity/v1', {
      schema: 'writcraft.object-identity/v1',
      dev: String(fileStat.dev),
      ino: String(fileStat.ino),
      uid: Number(fileStat.uid),
      mode: statMode(fileStat),
      nlink: Number(fileStat.nlink),
      size: String(fileStat.size),
      mtimeNs: String(fileStat.mtimeNs),
      ctimeNs: String(fileStat.ctimeNs),
      contentSha256,
    });
    const captureIdentity = {
      schema: 'writcraft.snapshot-capture-identity/v1',
      transactionId: TRANSACTION_ID,
      projectInstanceId: PROJECT_INSTANCE_ID,
      snapshotId: SNAPSHOT_ID,
      ownerGeneration: 17,
      creationMutationGeneration: 23,
      rootIdentityDigest,
      candidates: [{
        candidateId: opaqueCaptureId('candidate_', TRANSACTION_ID, SNAPSHOT_ID, 'chapter.md'),
        fileId: opaqueCaptureId('file_', TRANSACTION_ID, SNAPSHOT_ID, 'chapter.md'),
        revision: contentSha256.slice(7),
        byteLength: markdown.length,
        sha256: contentSha256,
        ancestorIdentityDigest,
        sourceObjectIdentityDigest,
      }],
    };
    assert.strictEqual(
      lines[4].split('\t')[4],
      evidenceSchema.digestObject('writcraft.snapshot-capture-identity/v1', captureIdentity),
      'native capture identity must reproduce from the exact frozen JS schema payload'
    );
    assert.strictEqual(lines[5], 'X\tOK');
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
  })
);

test('production capture protocol rejects caller-supplied path, body, or output fields', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    fs.writeFileSync(path.join(project, 'chapter.md'), '# private request\n', { mode: 0o600 });
    const result = runHelper(helper, project, productionCaptureProtocol(project, ['/tmp/output.wcsb']));
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim().split('\n').at(-1), 'G\tERR\tPROTOCOL');
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
  })
);

test('native T pass binds exact parser/capture/candidates and classifies excluded hrefs without copying them', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    fs.mkdirSync(path.join(project, 'chapters'));
    fs.mkdirSync(path.join(project, 'assets', 'generated'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'chapters', 'chapter.md'),
      '![eligible](../assets/generated/figure.png) ![remote](https://example.invalid/not-copied.png)\n',
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(project, 'assets', 'generated', 'figure.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      { mode: 0o600 }
    );
    const scanned = runHelper(helper, project, productionCaptureProtocol(project));
    assert.strictEqual(scanned.status, 0, scanned.stderr || scanned.stdout);
    const candidates = sealedCandidates(scanned.stdout);
    const api = snapshotImageTokenizer.createAdapter({
      marked,
      sha256Bytes: bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    });
    const pass = api.createTokenPass({ transactionId: TRANSACTION_ID, candidates });
    assert.strictEqual(pass.candidates[0].tokens.length, 2,
      'shared marked pass must retain excluded tokens for later Stage B blockers');
    const result = runHelper(helper, project, [
      ...productionCaptureCommands(project),
      ...tokenPassCommands(pass),
      'X',
      '',
    ].join('\n'));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(
      result.stdout.trim().split('\n').find(line => line.startsWith('K\tOK\t')),
      `K\tOK\t${TRANSACTION_ID}\t1\t1`
    );
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
  })
);

test('native T pass rejects a non-reproducible image-token locator before any private write', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    fs.writeFileSync(path.join(project, 'chapter.md'), '![x](figure.png)\n', { mode: 0o600 });
    fs.writeFileSync(path.join(project, 'figure.png'), 'image', { mode: 0o600 });
    const scanned = runHelper(helper, project, productionCaptureProtocol(project));
    const candidates = sealedCandidates(scanned.stdout);
    const api = snapshotImageTokenizer.createAdapter({
      marked,
      sha256Bytes: bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    });
    const validPass = api.createTokenPass({ transactionId: TRANSACTION_ID, candidates });
    const pass = structuredClone(validPass);
    pass.candidates[0].tokens[0].locatorDigest = `sha256:${'0'.repeat(64)}`;
    const result = runHelper(helper, project, [
      ...productionCaptureCommands(project),
      ...tokenPassCommands(pass),
      '',
    ].join('\n'));
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim().split('\n').at(-1), 'K\tERR\tTOKEN_PASS');
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
  })
);

test('production B rejects caller-supplied extra fields before any private transaction write', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    fs.writeFileSync(path.join(project, 'chapter.md'), '# exact B\n', { mode: 0o600 });
    const scanned = runHelper(helper, project, productionCaptureProtocol(project));
    const api = snapshotImageTokenizer.createAdapter({
      marked,
      sha256Bytes: bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    });
    const pass = api.createTokenPass({
      transactionId: TRANSACTION_ID,
      candidates: sealedCandidates(scanned.stdout),
    });
    const result = runHelper(helper, project, [
      ...productionCaptureCommands(project),
      ...tokenPassCommands(pass),
      `B\t${TRANSACTION_ID}\t/tmp/caller-output.wcsb`,
      '',
    ].join('\n'));
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim().split('\n').at(-1), 'B\tERR\tPROTOCOL');
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
  })
);

test('an eligible but missing image remains a retained reference and does not fail snapshot capture', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    fs.writeFileSync(path.join(project, 'chapter.md'), '![missing](assets/missing.png)\n', {
      mode: 0o600,
    });
    const scanned = runHelper(helper, project, productionCaptureProtocol(project));
    const candidates = sealedCandidates(scanned.stdout);
    const api = snapshotImageTokenizer.createAdapter({
      marked,
      sha256Bytes: bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    });
    const pass = api.createTokenPass({ transactionId: TRANSACTION_ID, candidates });
    const result = runHelper(helper, project, [
      ...productionCaptureCommands(project),
      ...tokenPassCommands(pass),
      'X',
      '',
    ].join('\n'));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(
      result.stdout.trim().split('\n').find(line => line.startsWith('K\tOK\t')),
      `K\tOK\t${TRANSACTION_ID}\t1\t0`
    );
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
  })
);

test('the native token budget counts excluded marked image tokens and rejects token 10001', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    fs.writeFileSync(
      path.join(project, 'chapter.md'),
      '![x](https://example.invalid/x.png)\n'.repeat(10000),
      { mode: 0o600 }
    );
    const scanned = runHelper(helper, project, productionCaptureProtocol(project));
    assert.strictEqual(scanned.status, 0, scanned.stderr || scanned.stdout);
    const api = snapshotImageTokenizer.createAdapter({
      marked,
      sha256Bytes: bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    });
    const validPass = api.createTokenPass({
      transactionId: TRANSACTION_ID,
      candidates: sealedCandidates(scanned.stdout),
    });
    const pass = structuredClone(validPass);
    const candidate = pass.candidates[0];
    const prior = candidate.tokens.at(-1);
    const tokenOrdinal = prior.tokenOrdinal + 2;
    const hrefBytes = Buffer.from(prior.hrefUtf8Base64, 'base64');
    const hrefSha256 = `sha256:${crypto.createHash('sha256').update(hrefBytes).digest('hex')}`;
    candidate.tokens.push({
      ...prior,
      tokenOrdinal,
      locatorDigest: evidenceSchema.digestObject('writcraft.snapshot-image-token-locator/v1', {
        schema: 'writcraft.snapshot-image-token-locator/v1',
        fileId: candidate.fileId,
        revision: candidate.revision,
        tokenOrdinal,
        rawTokenSha256: prior.rawTokenSha256,
        hrefSha256,
      }),
    });
    assert.strictEqual(pass.candidates[0].tokens.length, 10001);
    const canonicalBytes = Buffer.byteLength(api.canonicalJson(pass), 'utf8');
    assert.ok(canonicalBytes <= 4 * 1024 * 1024, 'fixture must cross token count, not byte budget');
    const result = runHelper(helper, project, [
      ...productionCaptureCommands(project),
      ...tokenPassCommands(pass),
      '',
    ].join('\n'));
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim().split('\n').at(-1), 'K\tERR\tTOKEN_PASS');
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
  })
);

test('production B builds, validates, no-clobber publishes, and persists formal transaction truth', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    fs.mkdirSync(path.join(project, 'chapters'));
    fs.mkdirSync(path.join(project, 'assets', 'generated'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'chapters', 'chapter.md'),
      '# Bundle\n\n![selected](../assets/generated/figure.png)\n',
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(project, 'assets', 'generated', 'figure.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
      { mode: 0o600 }
    );
    const scanned = runHelper(helper, project, productionCaptureProtocol(project));
    assert.strictEqual(scanned.status, 0, scanned.stderr || scanned.stdout);
    const candidates = sealedCandidates(scanned.stdout);
    const api = snapshotImageTokenizer.createAdapter({
      marked,
      sha256Bytes: bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    });
    const pass = api.createTokenPass({ transactionId: TRANSACTION_ID, candidates });
    const result = runHelper(helper, project, [
      ...productionCaptureCommands(project),
      ...tokenPassCommands(pass),
      `B\t${TRANSACTION_ID}`,
      'X',
      '',
    ].join('\n'));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const committed = result.stdout.trim().split('\n').find(line => line.startsWith('B\tOK\t'));
    assert.match(committed, new RegExp(
      `^B\\tOK\\t${TRANSACTION_ID}\\tCOMMITTED` +
      `\\tsha256:[a-f0-9]{64}\\tsha256:[a-f0-9]{64}\\tsha256:[a-f0-9]{64}$`
    ), result.stderr);
    assert.strictEqual(result.stdout.includes(project), false);
    assert.strictEqual(result.stdout.includes('chapters/chapter.md'), false);
    assert.strictEqual(result.stdout.includes('assets/generated/figure.png'), false);
    const finalName = digestBasename('bundle-', SNAPSHOT_ID, '.wcsb');
    const bundle = fs.readFileSync(path.join(privateRoot, 'bundles', finalName));
    const parsed = bundleService.parseBundle(bundle);
    assert.strictEqual(parsed.manifest.snapshotId, SNAPSHOT_ID);
    assert.strictEqual(parsed.manifest.producerVersion, APP_VERSION);
    assert.deepStrictEqual(parsed.manifest.files.map(file => [file.path, file.kind]), [
      ['assets/generated/figure.png', 'image'],
      ['chapters/chapter.md', 'markdown'],
    ]);
    assert.strictEqual(parsed.manifest.files[0].references.length, 1);
    assert.strictEqual(parsed.manifest.files[0].references[0].fromFileId,
      parsed.manifest.files[1].fileId);
    const transactionName = digestBasename('transaction-', TRANSACTION_ID, '.json');
    const transaction = JSON.parse(fs.readFileSync(
      path.join(privateRoot, 'control', transactionName), 'utf8'
    ));
    evidenceSchema.assertSnapshotTransaction(transaction, 'create', JSON.parse(fs.readFileSync(
      path.join(
        privateRoot,
        'control',
        digestBasename('receipt-', TRANSACTION_ID, '.json')
      ),
      'utf8'
    )));
    assert.strictEqual(transaction.state, 'COMMITTED');
    assert.strictEqual(transaction.snapshotManifestDigest, parsed.manifest.snapshotManifestDigest);
  })
);

test('a dropped production COMMITTED response is recovered by R without repeating G T K', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch, ['WRITCRAFT_TEST_DROP_PRODUCTION_COMMITTED_RESPONSE']);
    const normal = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    createPrivateTree(project);
    fs.writeFileSync(path.join(project, 'chapter.md'), '# response recovery\n', { mode: 0o600 });
    const scanned = runHelper(normal, project, productionCaptureProtocol(project));
    const candidates = sealedCandidates(scanned.stdout);
    const api = snapshotImageTokenizer.createAdapter({
      marked,
      sha256Bytes: bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    });
    const pass = api.createTokenPass({ transactionId: TRANSACTION_ID, candidates });
    const lost = runHelper(helper, project, [
      ...productionCaptureCommands(project),
      ...tokenPassCommands(pass),
      `B\t${TRANSACTION_ID}`,
      '',
    ].join('\n'));
    assert.strictEqual(lost.status, 88, lost.stderr || lost.stdout);
    assert.strictEqual(lost.stdout.includes('\tCOMMITTED\t'), false);
    const stageName = digestBasename('stage-', TRANSACTION_ID, '.wcsb');
    const finalName = digestBasename('bundle-', SNAPSHOT_ID, '.wcsb');
    const reconciled = runHelper(normal, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `R\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${stageName}\t${finalName}\t${COMMITTED_AT}`,
      '',
    ].join('\n'));
    assert.strictEqual(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    assert.match(reconciled.stdout.trim().split('\n').at(-1), new RegExp(
      `^R\\tOK\\t${TRANSACTION_ID}\\tCOMMITTED` +
      `\\tsha256:[a-f0-9]{64}\\tsha256:[a-f0-9]{64}$`
    ));
  })
);

test('R rechecks a late production final and returns exact COMMITTED instead of stale UNCOMMITTED', () =>
  withScratch(scratch => {
    const normal = compileHelper(scratch);
    const producer = compileHelper(scratch, ['WRITCRAFT_TEST_PAUSE_PRODUCTION_BEFORE_RENAME']);
    const reconciler = compileHelper(scratch, ['WRITCRAFT_TEST_PAUSE_RECONCILE_AFTER_FINAL_ABSENT']);
    const project = path.join(scratch, 'project');
    const sync = path.join(scratch, 'sync');
    fs.mkdirSync(project);
    fs.mkdirSync(sync, { mode: 0o700 });
    createPrivateTree(project);
    fs.writeFileSync(path.join(project, 'chapter.md'), '# late final race\n', { mode: 0o600 });
    const scanned = runHelper(normal, project, productionCaptureProtocol(project));
    const api = snapshotImageTokenizer.createAdapter({
      marked,
      sha256Bytes: bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    });
    const pass = api.createTokenPass({
      transactionId: TRANSACTION_ID,
      candidates: sealedCandidates(scanned.stdout),
    });
    const producerInput = [
      ...productionCaptureCommands(project),
      ...tokenPassCommands(pass),
      `B\t${TRANSACTION_ID}`,
      '',
    ].join('\n');
    const reconcileInput = [
      `P\t${encodeHex(project)}`,
      'D',
      `R\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${digestBasename('stage-', TRANSACTION_ID, '.wcsb')}` +
        `\t${digestBasename('bundle-', SNAPSHOT_ID, '.wcsb')}\t${COMMITTED_AT}`,
      '',
    ].join('\n');
    const driver = String.raw`
      const childProcess = require('child_process');
      const fs = require('fs');
      const [producer, reconciler, sync, producer64, reconcile64] = process.argv.slice(1);
      const environment = { ...process.env, WRITCRAFT_TEST_SYNC_DIR: sync };
      function launch(binary, input) {
        const rootFd = fs.openSync('/', fs.constants.O_RDONLY);
        const child = childProcess.spawn(binary, [], {
          stdio: ['pipe', 'pipe', 'pipe', rootFd], env: environment,
        });
        fs.closeSync(rootFd);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.stdin.end(Buffer.from(input, 'base64'));
        const closed = new Promise(resolve => child.on('close', (code, signal) =>
          resolve({ code, signal, stdout, stderr })));
        return { child, closed };
      }
      async function waitFor(file) {
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(file)) {
          if (Date.now() >= deadline) throw new Error('sync timeout: ' + file);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      (async () => {
        const first = launch(producer, producer64);
        await waitFor(sync + '/production-before-rename.ready');
        const second = launch(reconciler, reconcile64);
        await waitFor(sync + '/reconcile-final-absent.ready');
        fs.writeFileSync(sync + '/production-before-rename.release', '', { flag: 'wx' });
        const producerResult = await first.closed;
        fs.writeFileSync(sync + '/reconcile-final-absent.release', '', { flag: 'wx' });
        const reconcileResult = await second.closed;
        process.stdout.write(JSON.stringify({ producerResult, reconcileResult }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const driven = childProcess.execFileSync(process.execPath, [
      '-e', driver,
      producer,
      reconciler,
      sync,
      Buffer.from(producerInput).toString('base64'),
      Buffer.from(reconcileInput).toString('base64'),
    ], { encoding: 'utf8', timeout: 30000 });
    const result = JSON.parse(driven);
    assert.strictEqual(result.producerResult.code, 0, result.producerResult.stderr);
    assert.strictEqual(result.reconcileResult.code, 0, result.reconcileResult.stderr);
    assert.match(
      result.reconcileResult.stdout.trim().split('\n').at(-1),
      new RegExp(`^R\\tOK\\t${TRANSACTION_ID}\\tCOMMITTED\\tsha256:[a-f0-9]{64}`)
    );
    const privateRoot = path.join(project, '.writcraft', 'snapshots', 'v1');
    assert.ok(fs.existsSync(path.join(
      privateRoot,
      'bundles',
      digestBasename('bundle-', SNAPSHOT_ID, '.wcsb')
    )));
    const transaction = JSON.parse(fs.readFileSync(path.join(
      privateRoot,
      'control',
      digestBasename('transaction-', TRANSACTION_ID, '.json')
    ), 'utf8'));
    const receipt = JSON.parse(fs.readFileSync(path.join(
      privateRoot,
      'control',
      digestBasename('receipt-', TRANSACTION_ID, '.json')
    ), 'utf8'));
    evidenceSchema.assertSnapshotTransaction(transaction, 'create', receipt);
    assert.strictEqual(transaction.state, 'COMMITTED');
  })
);

test('a production prepublish crash is reconciled from formal transaction ownership to UNCOMMITTED', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch, ['WRITCRAFT_TEST_CRASH_PRODUCTION_BEFORE_PUBLISH']);
    const normal = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    fs.writeFileSync(path.join(project, 'chapter.md'), '# prepublish recovery\n', { mode: 0o600 });
    const scanned = runHelper(normal, project, productionCaptureProtocol(project));
    const candidates = sealedCandidates(scanned.stdout);
    const api = snapshotImageTokenizer.createAdapter({
      marked,
      sha256Bytes: bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    });
    const pass = api.createTokenPass({ transactionId: TRANSACTION_ID, candidates });
    const crashed = runHelper(helper, project, [
      ...productionCaptureCommands(project),
      ...tokenPassCommands(pass),
      `B\t${TRANSACTION_ID}`,
      '',
    ].join('\n'));
    assert.strictEqual(crashed.status, 89, crashed.stderr || crashed.stdout);
    const stageName = digestBasename('stage-', TRANSACTION_ID, '.wcsb');
    const finalName = digestBasename('bundle-', SNAPSHOT_ID, '.wcsb');
    assert.ok(fs.existsSync(path.join(privateRoot, 'control', stageName)));
    const transactionPath = path.join(
      privateRoot,
      'control',
      digestBasename('transaction-', TRANSACTION_ID, '.json')
    );
    const exactTransaction = fs.readFileSync(transactionPath, 'utf8');
    fs.writeFileSync(
      transactionPath,
      exactTransaction.replace('"ownerGeneration":17', '"evil":true,"ownerGeneration":17'),
      { mode: 0o600 }
    );
    const rejected = runHelper(normal, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `R\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${stageName}\t${finalName}\t${COMMITTED_AT}`,
      '',
    ].join('\n'));
    assert.notStrictEqual(rejected.status, 0);
    assert.strictEqual(rejected.stdout.trim().split('\n').at(-1), 'R\tERR\tUNKNOWN');
    assert.ok(fs.existsSync(path.join(privateRoot, 'control', stageName)),
      'malformed transaction must preserve possible stage evidence');
    fs.writeFileSync(transactionPath, exactTransaction, { mode: 0o600 });
    const reconciled = runHelper(normal, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `R\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${stageName}\t${finalName}\t${COMMITTED_AT}`,
      '',
    ].join('\n'));
    assert.strictEqual(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    assert.strictEqual(
      reconciled.stdout.trim().split('\n').at(-1),
      `R\tOK\t${TRANSACTION_ID}\tUNCOMMITTED`
    );
    assert.strictEqual(fs.existsSync(path.join(privateRoot, 'control', stageName)), false);
    assert.strictEqual(fs.existsSync(path.join(privateRoot, 'bundles', finalName)), false);
    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    evidenceSchema.assertSnapshotTransaction(transaction, 'create');
    assert.strictEqual(transaction.state, 'UNCOMMITTED');
    assert.strictEqual(transaction.lastErrorCode, 'RECOVERED_UNCOMMITTED');
  })
);

test('production B preserves a colliding final and settles its own stage UNCOMMITTED', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    fs.writeFileSync(path.join(project, 'chapter.md'), '# collision\n', { mode: 0o600 });
    const finalName = digestBasename('bundle-', SNAPSHOT_ID, '.wcsb');
    const existing = Buffer.from('not this transaction');
    fs.writeFileSync(path.join(privateRoot, 'bundles', finalName), existing, {
      mode: 0o600,
      flag: 'wx',
    });
    const scanned = runHelper(helper, project, productionCaptureProtocol(project));
    const candidates = sealedCandidates(scanned.stdout);
    const api = snapshotImageTokenizer.createAdapter({
      marked,
      sha256Bytes: bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    });
    const pass = api.createTokenPass({ transactionId: TRANSACTION_ID, candidates });
    const result = runHelper(helper, project, [
      ...productionCaptureCommands(project),
      ...tokenPassCommands(pass),
      `B\t${TRANSACTION_ID}`,
      'X',
      '',
    ].join('\n'));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout.trim().split('\n').find(line => line.startsWith('B\tOK\t')),
      new RegExp(`^B\\tOK\\t${TRANSACTION_ID}\\tUNCOMMITTED\\tsha256:[a-f0-9]{64}\\tFINAL_EXISTS$`));
    assert.ok(fs.readFileSync(path.join(privateRoot, 'bundles', finalName)).equals(existing));
    assert.strictEqual(fs.existsSync(path.join(
      privateRoot,
      'control',
      digestBasename('stage-', TRANSACTION_ID, '.wcsb')
    )), false);
    const transaction = JSON.parse(fs.readFileSync(path.join(
      privateRoot,
      'control',
      digestBasename('transaction-', TRANSACTION_ID, '.json')
    ), 'utf8'));
    evidenceSchema.assertSnapshotTransaction(transaction, 'create');
    assert.strictEqual(transaction.state, 'UNCOMMITTED');
    assert.strictEqual(transaction.lastErrorCode, 'FINAL_EXISTS');
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), [
      digestBasename('transaction-', TRANSACTION_ID, '.json'),
    ], 'settled collision must leave only the formal terminal transaction record');
  })
);

test('a same-inode source rewrite after K is detected by the final recheck with zero publish', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    fs.writeFileSync(path.join(project, 'chapter.md'), '# original data\n', { mode: 0o600 });
    const before = fs.statSync(path.join(project, 'chapter.md'));
    const scanned = runHelper(helper, project, productionCaptureProtocol(project));
    const api = snapshotImageTokenizer.createAdapter({
      marked,
      sha256Bytes: bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    });
    const pass = api.createTokenPass({
      transactionId: TRANSACTION_ID,
      candidates: sealedCandidates(scanned.stdout),
    });
    const result = runAfterKMutation(helper, project, [
      ...productionCaptureCommands(project),
      ...tokenPassCommands(pass),
    ], 'same-inode');
    assert.strictEqual(result.mutated, true);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(
      `B\\tOK\\t${TRANSACTION_ID}\\tUNCOMMITTED\\tsha256:[a-f0-9]{64}\\tSOURCE_STALE`
    ));
    const after = fs.statSync(path.join(project, 'chapter.md'));
    assert.strictEqual(after.ino, before.ino, 'fault must cross the same-inode rewrite boundary');
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
  })
);

test('an ancestor replacement after K fails closed before no-clobber publish', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(path.join(project, 'chapters'), { recursive: true });
    const privateRoot = createPrivateTree(project);
    fs.writeFileSync(path.join(project, 'chapters', 'chapter.md'), '# original\n', { mode: 0o600 });
    const scanned = runHelper(helper, project, productionCaptureProtocol(project));
    const api = snapshotImageTokenizer.createAdapter({
      marked,
      sha256Bytes: bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    });
    const pass = api.createTokenPass({
      transactionId: TRANSACTION_ID,
      candidates: sealedCandidates(scanned.stdout),
    });
    const result = runAfterKMutation(helper, project, [
      ...productionCaptureCommands(project),
      ...tokenPassCommands(pass),
    ], 'ancestor');
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\tUNCOMMITTED\tsha256:[a-f0-9]{64}\tSOURCE_STALE/);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
  })
);

test('a project-root replacement after K fails at root authority with zero private publish', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    fs.writeFileSync(path.join(project, 'chapter.md'), '# root drift\n', { mode: 0o600 });
    const scanned = runHelper(helper, project, productionCaptureProtocol(project));
    const api = snapshotImageTokenizer.createAdapter({
      marked,
      sha256Bytes: bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    });
    const pass = api.createTokenPass({
      transactionId: TRANSACTION_ID,
      candidates: sealedCandidates(scanned.stdout),
    });
    const result = runAfterKMutation(helper, project, [
      ...productionCaptureCommands(project),
      ...tokenPassCommands(pass),
    ], 'root');
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.strictEqual(result.stdout.trim().split('\n').at(-1), 'B\tERR\tROOT');
    const movedPrivateRoot = privateRoot.replace(project, `${project}-old`);
    assert.deepStrictEqual(fs.readdirSync(path.join(movedPrivateRoot, 'bundles')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(movedPrivateRoot, 'control')), []);
  })
);

test('binds from filesystem root, writes one exact stage, then proves zero-publish cancellation', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const result = runHelper(helper, project, protocol({ project }));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const lines = result.stdout.trim().split('\n');
    assert.match(lines[0], /^P\tOK\t[0-9]+\t[0-9]+\t[0-9]+\t[0-9]+$/);
    assert.match(lines[1], /^D\tOK\tcontrol\t[0-9]+\t[0-9]+\t[0-9]+\t448\tbundles\t[0-9]+\t[0-9]+\t[0-9]+\t448\tquarantine\t[0-9]+\t[0-9]+\t[0-9]+\t448$/);
    assert.match(lines[2], new RegExp(`^S\\tOK\\t${TRANSACTION_ID}\\t${SNAPSHOT_ID}\\t[0-9]+\\t[0-9]+\\t[0-9]+\\t384\\t1\\t0$`));
    const fixture = createBundleFixture();
    const expectedLength = fixture.bundle.length;
    assert.strictEqual(lines[3], `W\tOK\t${TRANSACTION_ID}\t${expectedLength}`);
    assert.match(lines[4], new RegExp(
      `^F\\tOK\\t${TRANSACTION_ID}\\t${SNAPSHOT_ID}\\t[0-9]+\\t[0-9]+\\t[0-9]+` +
      `\\t384\\t1\\t${expectedLength}\\tsha256:[a-f0-9]{64}\\t${fixture.manifest.snapshotManifestDigest}$`
    ));
    assert.strictEqual(lines[5], `C\tOK\t${TRANSACTION_ID}\tUNCOMMITTED`);
    assert.strictEqual(lines[6], 'X\tOK');

    const rootFields = lines[0].split('\t');
    const directoryFields = lines[1].split('\t');
    const finishFields = lines[4].split('\t');
    assert.strictEqual(finishFields[10], fixture.bundlePayloadSha256,
      'native bundlePayloadSha256 must exclude the trailing raw SHA and footer exactly like JS');
    const rootIdentity = {
      schema: evidenceSchema.SCHEMAS.ROOT_IDENTITY,
      dev: rootFields[2],
      ino: rootFields[3],
      uid: Number(rootFields[4]),
      mode: Number(rootFields[5]),
    };
    evidenceSchema.assertRootIdentity(rootIdentity);
    const controlIdentity = {
      schema: evidenceSchema.SCHEMAS.SNAPSHOT_PRIVATE_PARENT_IDENTITY,
      role: directoryFields[2],
      rootIdentityDigest: evidenceSchema.digestRootIdentity(rootIdentity),
      dev: directoryFields[3],
      ino: directoryFields[4],
      uid: Number(directoryFields[5]),
      mode: Number(directoryFields[6]),
    };
    evidenceSchema.assertSnapshotPrivateParentIdentity(controlIdentity);
    const stageIdentity = {
      schema: evidenceSchema.SCHEMAS.SNAPSHOT_STAGE_IDENTITY,
      transactionId: finishFields[2],
      snapshotId: finishFields[3],
      parentIdentityDigest: evidenceSchema.digestSnapshotPrivateParentIdentity(controlIdentity),
      stageBasenameSha256: `sha256:${crypto.createHash('sha256').update(STAGE_NAME).digest('hex')}`,
      dev: finishFields[4],
      ino: finishFields[5],
      uid: Number(finishFields[6]),
      mode: Number(finishFields[7]),
      nlink: Number(finishFields[8]),
      size: finishFields[9],
      bundlePayloadSha256: finishFields[10],
      snapshotManifestDigest: finishFields[11],
    };
    evidenceSchema.assertSnapshotStageIdentity(stageIdentity, controlIdentity);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'quarantine')), []);
  })
);

test('rejects a private parent whose mode is not 0700 before stage creation', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project, 0o755);
    const result = runHelper(helper, project, [
      `P\t${encodeHex(project)}`,
      'D',
      'X',
      '',
    ].join('\n'));
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim().split('\n').at(-1), 'D\tERR\tPRIVATE_PARENT');
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
  })
);

test('uses O_EXCL and never truncates a colliding stage', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const stage = path.join(privateRoot, 'control', STAGE_NAME);
    fs.writeFileSync(stage, 'keep-me', { mode: 0o600, flag: 'wx' });
    const result = runHelper(helper, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t32`,
      '',
    ].join('\n'));
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim().split('\n').at(-1), 'S\tERR\tSTAGE_EXISTS');
    assert.strictEqual(fs.readFileSync(stage, 'utf8'), 'keep-me');
  })
);

test('a partial-write fault still permits exact-owned UNCOMMITTED cleanup', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch, ['WRITCRAFT_TEST_PARTIAL_WRITE_FAIL']);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const content = Buffer.alloc(64, 0x61);
    const result = runHelper(helper, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${content.length}`,
      `W\t${TRANSACTION_ID}\t${content.toString('hex')}`,
      `C\t${TRANSACTION_ID}`,
      'X',
      '',
    ].join('\n'));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const lines = result.stdout.trim().split('\n');
    assert.strictEqual(lines[3], 'W\tERR\tIO');
    assert.strictEqual(lines[4], `C\tOK\t${TRANSACTION_ID}\tUNCOMMITTED`);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
  })
);

test('refuses to delete a concurrent replacement at the stage name', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch, ['WRITCRAFT_TEST_REPLACE_STAGE_BEFORE_CANCEL']);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const result = runHelper(helper, project, protocol({ project }));
    assert.notStrictEqual(result.status, 0);
    const lines = result.stdout.trim().split('\n');
    assert.strictEqual(lines.at(-1), 'C\tERR\tIDENTITY');
    assert.strictEqual(
      fs.readFileSync(path.join(privateRoot, 'control', STAGE_NAME), 'utf8'),
      'replacement'
    );
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
  })
);

test('rejects a staged file that is not the frozen snapshot bundle framing before publish', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const invalid = Buffer.from('snapshot-bundle-fixture', 'utf8');
    const result = runHelper(helper, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${invalid.length}`,
      `W\t${TRANSACTION_ID}\t${invalid.toString('hex')}`,
      `F\t${TRANSACTION_ID}\tsha256:${'8'.repeat(64)}`,
      `C\t${TRANSACTION_ID}`,
      'X',
      '',
    ].join('\n'));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(result.stdout.trim().split('\n')[4], 'F\tERR\tBUNDLE');
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
  })
);

test('rejects payload corruption in an otherwise framed bundle and still proves exact cancellation', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const fixture = createBundleFixture();
    const corrupt = Buffer.from(fixture.bundle);
    corrupt[corrupt.length - 41] ^= 0x01;
    const result = runHelper(helper, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${corrupt.length}`,
      ...writeCommands(TRANSACTION_ID, corrupt),
      `F\t${TRANSACTION_ID}\t${fixture.manifest.snapshotManifestDigest}`,
      `C\t${TRANSACTION_ID}`,
      'X',
      '',
    ].join('\n'));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const lines = result.stdout.trim().split('\n');
    assert.strictEqual(lines[4], 'F\tERR\tBUNDLE');
    assert.strictEqual(lines[5], `C\tOK\t${TRANSACTION_ID}\tUNCOMMITTED`);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
  })
);

test('recomputes the manifest self-digest instead of trusting its embedded digest string', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    createPrivateTree(project);
    const fixture = createBundleFixture();
    const forged = Buffer.from(fixture.bundle);
    const manifestLength = forged.readUInt32BE(8);
    const manifest = forged.subarray(12, 12 + manifestLength);
    const oldProducer = Buffer.from('0.3.0-stage-a1');
    const producerOffset = manifest.indexOf(oldProducer);
    assert(producerOffset >= 0);
    Buffer.from('0.3.0-stage-b1').copy(manifest, producerOffset);
    const resealed = resealOuterPayload(forged);
    const result = runHelper(helper, project, [
      `P\t${encodeHex(project)}`, 'D',
      `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${resealed.length}`,
      ...writeCommands(TRANSACTION_ID, resealed),
      `F\t${TRANSACTION_ID}\t${fixture.manifest.snapshotManifestDigest}`,
      `C\t${TRANSACTION_ID}`, 'X', '',
    ].join('\n'));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(result.stdout.trim().split('\n')[4], 'F\tERR\tBUNDLE');
  })
);

test('binds every entry header and content to the ordered manifest bundleObjectDigest', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    createPrivateTree(project);
    const fixture = createBundleFixture();
    const forged = Buffer.from(fixture.bundle);
    const parsed = bundleService.parseBundle(forged);
    const contentOffset = parsed.bindings[0].contentOffset;
    forged[contentOffset] ^= 0x01;
    const manifestLength = forged.readUInt32BE(8);
    const headerLengthOffset = 12 + manifestLength + 4;
    const headerLength = forged.readUInt32BE(headerLengthOffset);
    const header = forged.subarray(headerLengthOffset + 4, headerLengthOffset + 4 + headerLength);
    const shaPrefix = Buffer.from('"sha256":"');
    const shaOffset = header.indexOf(shaPrefix) + shaPrefix.length;
    assert(shaOffset >= shaPrefix.length);
    const contentLength = Number(forged.readBigUInt64BE(headerLengthOffset + 4 + headerLength));
    const newDigest = bundleService.digestBytes(forged.subarray(contentOffset, contentOffset + contentLength));
    Buffer.from(newDigest).copy(header, shaOffset);
    const resealed = resealOuterPayload(forged);
    const result = runHelper(helper, project, [
      `P\t${encodeHex(project)}`, 'D',
      `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${resealed.length}`,
      ...writeCommands(TRANSACTION_ID, resealed),
      `F\t${TRANSACTION_ID}\t${fixture.manifest.snapshotManifestDigest}`,
      `C\t${TRANSACTION_ID}`, 'X', '',
    ].join('\n'));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(result.stdout.trim().split('\n')[4], 'F\tERR\tBUNDLE');
  })
);

test('publishes with no-clobber, persists committed control truth, reconciles, and lists', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const fixture = createBundleFixture();
    const published = runHelper(helper, project, protocol({ project, fixture, publish: true }));
    assert.strictEqual(published.status, 0, published.stderr || published.stdout);
    const publishLine = published.stdout.trim().split('\n').at(-2);
    assert.match(publishLine, new RegExp(
      `^A\\tOK\\t${TRANSACTION_ID}\\tCOMMITTED\\tsha256:[a-f0-9]{64}` +
      `\\tsha256:[a-f0-9]{64}$`
    ));
    assert.ok(fs.readFileSync(path.join(privateRoot, 'bundles', FINAL_NAME)).equals(fixture.bundle));
    const publishFields = publishLine.split('\t');
    const lines = published.stdout.trim().split('\n');
    const rootFields = lines[0].split('\t');
    const directoryFields = lines[1].split('\t');
    const rootIdentity = {
      schema: evidenceSchema.SCHEMAS.ROOT_IDENTITY,
      dev: rootFields[2], ino: rootFields[3], uid: Number(rootFields[4]), mode: Number(rootFields[5]),
    };
    const bundlesIdentity = {
      schema: evidenceSchema.SCHEMAS.SNAPSHOT_PRIVATE_PARENT_IDENTITY,
      role: directoryFields[7],
      rootIdentityDigest: evidenceSchema.digestRootIdentity(rootIdentity),
      dev: directoryFields[8], ino: directoryFields[9],
      uid: Number(directoryFields[10]), mode: Number(directoryFields[11]),
    };
    const finalStat = fs.statSync(path.join(privateRoot, 'bundles', FINAL_NAME), { bigint: true });
    const publishedIdentity = {
      schema: evidenceSchema.SCHEMAS.SNAPSHOT_PUBLISHED_IDENTITY,
      snapshotId: SNAPSHOT_ID,
      parentIdentityDigest: evidenceSchema.digestSnapshotPrivateParentIdentity(bundlesIdentity),
      finalBasenameSha256: `sha256:${crypto.createHash('sha256').update(FINAL_NAME).digest('hex')}`,
      dev: String(finalStat.dev), ino: String(finalStat.ino), uid: Number(finalStat.uid), mode: 0o600,
      nlink: Number(finalStat.nlink), size: String(finalStat.size),
      bundlePayloadSha256: fixture.bundlePayloadSha256,
      snapshotManifestDigest: fixture.manifest.snapshotManifestDigest,
    };
    assert.strictEqual(
      evidenceSchema.digestSnapshotPublishedIdentity(publishedIdentity, bundlesIdentity),
      publishFields[4]
    );
    const controlFiles = fs.readdirSync(path.join(privateRoot, 'control')).sort();
    assert.strictEqual(controlFiles.length, 2);
    const records = controlFiles.map(name => JSON.parse(
      fs.readFileSync(path.join(privateRoot, 'control', name), 'utf8')
    ));
    const receipt = records.find(record => record.schema === 'writcraft.snapshot-receipt/v1');
    const recovery = records.find(record => record.schema === 'writcraft.snapshot-recovery/v1');
    evidenceSchema.assertSnapshotReceipt(receipt, 'create');
    evidenceSchema.assertSnapshotRecovery(recovery, 'create', receipt);
    assert.strictEqual(recovery.state, 'COMMITTED');

    const inspected = runHelper(helper, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `R\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${FINAL_NAME}\t${COMMITTED_AT}`,
      'L',
      'X',
      '',
    ].join('\n'));
    assert.strictEqual(inspected.status, 0, inspected.stderr || inspected.stdout);
    const inspectLines = inspected.stdout.trim().split('\n');
    assert.match(inspectLines[2], new RegExp(`^R\\tOK\\t${TRANSACTION_ID}\\tCOMMITTED\\t`));
    assert.match(inspectLines[3], new RegExp(`^L\\tITEM\\t${SNAPSHOT_ID}\\t${fixture.manifest.snapshotManifestDigest}\\t`));
    assert.strictEqual(inspectLines[4], 'L\tOK\t1\t0\t0');
  })
);

test('a committed-then-threw publish is completed only by disk reconciliation', () =>
  withScratch(scratch => {
    const crashHelper = compileHelper(scratch, ['WRITCRAFT_TEST_CRASH_AFTER_PUBLISH']);
    const normalHelper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const fixture = createBundleFixture();
    const crashed = runHelper(crashHelper, project, protocol({ project, fixture, publish: true }));
    assert.notStrictEqual(crashed.status, 0);
    assert.ok(fs.existsSync(path.join(privateRoot, 'bundles', FINAL_NAME)));
    assert.ok(!fs.existsSync(path.join(privateRoot, 'control', STAGE_NAME)));

    const reconciled = runHelper(normalHelper, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `R\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${FINAL_NAME}\t${COMMITTED_AT}`,
      'L',
      'X',
      '',
    ].join('\n'));
    assert.strictEqual(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    const lines = reconciled.stdout.trim().split('\n');
    assert.match(lines[2], new RegExp(`^R\\tOK\\t${TRANSACTION_ID}\\tCOMMITTED\\t`));
    assert.match(lines[3], new RegExp(`^L\\tITEM\\t${SNAPSHOT_ID}\\t`));
    assert.strictEqual(lines[4], 'L\tOK\t1\t0\t0');
  })
);

test('an S response loss leaves durable native reservation truth that a later R can settle', () =>
  withScratch(scratch => {
    const crashHelper = compileHelper(scratch, ['WRITCRAFT_TEST_CRASH_AFTER_STAGE_RESERVATION']);
    const normalHelper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const crashed = runHelper(crashHelper, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t32`,
      '',
    ].join('\n'));
    assert.notStrictEqual(crashed.status, 0);
    assert.deepStrictEqual(crashed.stdout.trim().split('\n').map(line => line[0]), ['P', 'D']);
    const stranded = fs.readdirSync(path.join(privateRoot, 'control')).sort();
    assert.strictEqual(stranded.length, 2);
    assert.ok(stranded.includes(STAGE_NAME));
    const reservationName = stranded.find(name => name.startsWith('stage-reservation-'));
    assert.ok(reservationName);
    const reservation = JSON.parse(
      fs.readFileSync(path.join(privateRoot, 'control', reservationName), 'utf8')
    );
    assert.strictEqual(reservation.schema, 'writcraft.snapshot-stage-reservation/v1');
    assert.strictEqual(reservation.transactionId, TRANSACTION_ID);
    assert.strictEqual(reservation.snapshotId, SNAPSHOT_ID);
    assert.strictEqual(reservation.stageBasename, STAGE_NAME);
    assert.strictEqual(reservation.expectedBytes, '32');

    const reconciled = runHelper(normalHelper, project, reconcileProtocol(project, ['X']));
    assert.strictEqual(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    assert.strictEqual(
      reconciled.stdout.trim().split('\n')[2],
      `R\tOK\t${TRANSACTION_ID}\tUNCOMMITTED`
    );
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
  })
);

test('a pre-publish crash reconciles to UNCOMMITTED only after exact stage and marker cleanup fsync', () =>
  withScratch(scratch => {
    const crashHelper = compileHelper(scratch, ['WRITCRAFT_TEST_CRASH_BEFORE_PUBLISH']);
    const normalHelper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const crashed = runHelper(crashHelper, project, protocol({ project, publish: true }));
    assert.notStrictEqual(crashed.status, 0);
    assert.ok(fs.existsSync(path.join(privateRoot, 'control', STAGE_NAME)));
    assert.strictEqual(fs.readdirSync(path.join(privateRoot, 'control')).length, 3);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'bundles')), []);
    const reconciled = runHelper(normalHelper, project, [
      `P\t${encodeHex(project)}`, 'D',
      `R\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${FINAL_NAME}\t${COMMITTED_AT}`,
      'L', 'X', '',
    ].join('\n'));
    assert.strictEqual(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    const lines = reconciled.stdout.trim().split('\n');
    assert.strictEqual(lines[2], `R\tOK\t${TRANSACTION_ID}\tUNCOMMITTED`);
    assert.strictEqual(lines[3], 'L\tOK\t0\t0\t0');
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
  })
);

test('stage-unlink to marker-unlink failure first returns UNKNOWN, then the same R converges', () =>
  withScratch(scratch => {
    const crashHelper = compileHelper(scratch, ['WRITCRAFT_TEST_CRASH_BEFORE_PUBLISH']);
    const faultHelper = compileHelper(scratch, ['WRITCRAFT_TEST_FAIL_AFTER_STAGE_CLEANUP']);
    const normalHelper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    assert.notStrictEqual(
      runHelper(crashHelper, project, protocol({ project, publish: true })).status,
      0
    );

    const first = runHelper(faultHelper, project, reconcileProtocol(project));
    assert.notStrictEqual(first.status, 0);
    assert.strictEqual(first.stdout.trim().split('\n').at(-1), 'R\tERR\tUNKNOWN');
    const afterFirst = fs.readdirSync(path.join(privateRoot, 'control')).sort();
    assert.ok(!afterFirst.includes(STAGE_NAME));
    assert.ok(afterFirst.some(name => name.startsWith('recovery-')));
    assert.ok(afterFirst.some(name => name.startsWith('stage-reservation-')));

    const replacementPath = path.join(privateRoot, 'control', STAGE_NAME);
    fs.writeFileSync(replacementPath, 'late-replacement', { mode: 0o600, flag: 'wx' });
    const replacementRun = runHelper(normalHelper, project, reconcileProtocol(project));
    assert.notStrictEqual(replacementRun.status, 0);
    assert.strictEqual(replacementRun.stdout.trim().split('\n').at(-1), 'R\tERR\tUNKNOWN');
    assert.strictEqual(fs.readFileSync(replacementPath, 'utf8'), 'late-replacement');
    fs.unlinkSync(replacementPath);

    const settled = runHelper(normalHelper, project, reconcileProtocol(project, ['X']));
    assert.strictEqual(settled.status, 0, settled.stderr || settled.stdout);
    assert.strictEqual(settled.stdout.trim().split('\n')[2], `R\tOK\t${TRANSACTION_ID}\tUNCOMMITTED`);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
  })
);

test('marker-unlink to directory-fsync failure preserves UNKNOWN truth until the same R settles it', () =>
  withScratch(scratch => {
    const crashHelper = compileHelper(scratch, ['WRITCRAFT_TEST_CRASH_BEFORE_PUBLISH']);
    const stageFaultHelper = compileHelper(scratch, ['WRITCRAFT_TEST_FAIL_AFTER_STAGE_CLEANUP']);
    const markerFaultHelper = compileHelper(scratch, ['WRITCRAFT_TEST_FAIL_AFTER_MARKER_UNLINK']);
    const normalHelper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    assert.notStrictEqual(
      runHelper(crashHelper, project, protocol({ project, publish: true })).status,
      0
    );
    assert.notStrictEqual(runHelper(stageFaultHelper, project, reconcileProtocol(project)).status, 0);

    const first = runHelper(markerFaultHelper, project, reconcileProtocol(project));
    assert.notStrictEqual(first.status, 0);
    assert.strictEqual(first.stdout.trim().split('\n').at(-1), 'R\tERR\tUNKNOWN');
    const afterFirst = fs.readdirSync(path.join(privateRoot, 'control')).sort();
    assert.ok(!afterFirst.includes(STAGE_NAME));
    assert.ok(!afterFirst.some(name => name.startsWith('recovery-')));
    assert.ok(afterFirst.some(name => name.startsWith('stage-reservation-')));

    const second = runHelper(normalHelper, project, reconcileProtocol(project, ['X']));
    assert.strictEqual(second.status, 0, second.stderr || second.stdout);
    assert.strictEqual(second.stdout.trim().split('\n')[2], `R\tOK\t${TRANSACTION_ID}\tUNCOMMITTED`);
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
  })
);

test('a no-clobber collision preserves the existing final and returns proven UNCOMMITTED', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const finalPath = path.join(privateRoot, 'bundles', FINAL_NAME);
    fs.writeFileSync(finalPath, 'existing-final', { mode: 0o600, flag: 'wx' });
    const result = runHelper(helper, project, protocol({ project, publish: true }));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const lines = result.stdout.trim().split('\n');
    assert.strictEqual(lines.at(-2), `A\tOK\t${TRANSACTION_ID}\tUNCOMMITTED\tFINAL_EXISTS`);
    assert.strictEqual(fs.readFileSync(finalPath, 'utf8'), 'existing-final');
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), []);
  })
);

test('reconciliation returns UNKNOWN and preserves both evidence and a late final replacement', () =>
  withScratch(scratch => {
    const crashHelper = compileHelper(scratch, ['WRITCRAFT_TEST_CRASH_AFTER_PUBLISH']);
    const normalHelper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const crashed = runHelper(crashHelper, project, protocol({ project, publish: true }));
    assert.notStrictEqual(crashed.status, 0);
    const finalPath = path.join(privateRoot, 'bundles', FINAL_NAME);
    const orphanPath = path.join(privateRoot, 'bundles', 'orphan-original-test');
    fs.renameSync(finalPath, orphanPath);
    fs.writeFileSync(finalPath, 'replacement', { mode: 0o600, flag: 'wx' });
    const markerNames = fs.readdirSync(path.join(privateRoot, 'control'));
    assert.strictEqual(markerNames.length, 2);

    const reconciled = runHelper(normalHelper, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `R\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${FINAL_NAME}\t${COMMITTED_AT}`,
      '',
    ].join('\n'));
    assert.notStrictEqual(reconciled.status, 0);
    assert.strictEqual(reconciled.stdout.trim().split('\n').at(-1), 'R\tERR\tUNKNOWN');
    assert.strictEqual(fs.readFileSync(finalPath, 'utf8'), 'replacement');
    assert.ok(fs.existsSync(orphanPath));
    assert.deepStrictEqual(fs.readdirSync(path.join(privateRoot, 'control')), markerNames);
  })
);

test('O derives the final only from snapshotId and streams the exact receipt-bound committed bundle', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const fixture = createBundleFixture();
    const finalName = digestBasename('bundle-', SNAPSHOT_ID, '.wcsb');
    const published = runHelper(helper, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${fixture.bundle.length}`,
      ...writeCommands(TRANSACTION_ID, fixture.bundle),
      `F\t${TRANSACTION_ID}\t${fixture.manifest.snapshotManifestDigest}`,
      `A\t${TRANSACTION_ID}\t${finalName}\t${COMMITTED_AT}`,
      'X',
      '',
    ].join('\n'));
    assert.strictEqual(published.status, 0, published.stderr || published.stdout);
    assert.ok(fs.existsSync(path.join(privateRoot, 'bundles', finalName)));

    const read = runHelper(helper, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `O\t${SNAPSHOT_ID}`,
      'X',
      '',
    ].join('\n'));
    assert.strictEqual(read.status, 0, read.stderr || read.stdout);
    const lines = read.stdout.trim().split('\n');
    const start = lines[2].split('\t');
    assert.deepStrictEqual(start.slice(0, 4), [
      'O', 'START', SNAPSHOT_ID, fixture.manifest.snapshotManifestDigest,
    ]);
    assert.match(start[4], /^sha256:[a-f0-9]{64}$/);
    assert.match(start[5], /^sha256:[a-f0-9]{64}$/);
    assert.strictEqual(start[6], fixture.bundlePayloadSha256);
    assert.strictEqual(Number(start[7]), fixture.bundle.length);
    const chunks = lines.filter(line => line.startsWith('O\tBYTES\t')).map(line => {
      const fields = line.split('\t');
      return { offset: Number(fields[2]), bytes: Buffer.from(fields[3], 'hex') };
    });
    let offset = 0;
    for (const chunk of chunks) {
      assert.strictEqual(chunk.offset, offset);
      offset += chunk.bytes.length;
    }
    assert.ok(Buffer.concat(chunks.map(chunk => chunk.bytes)).equals(fixture.bundle));
    assert.strictEqual(lines.at(-2), `O\tOK\t${fixture.bundle.length}`);
    assert.strictEqual(lines.at(-1), 'X\tOK');

    const rejected = runHelper(helper, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `O\t${SNAPSHOT_ID}\t${finalName}`,
      '',
    ].join('\n'));
    assert.notStrictEqual(rejected.status, 0);
    assert.strictEqual(rejected.stdout.trim().split('\n').at(-1), 'O\tERR\tPROTOCOL');
  })
);

test('L terminal rejects a late duplicate canonical matching receipt without deleting it', () =>
  withScratch(scratch => {
    const normal = compileHelper(scratch);
    const paused = compileHelper(scratch, ['WRITCRAFT_TEST_PAUSE_COMMITTED_LIST_BEFORE_TERMINAL']);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    const fixture = createBundleFixture();
    const finalName = digestBasename('bundle-', SNAPSHOT_ID, '.wcsb');
    const published = runHelper(normal, project, [
      `P\t${encodeHex(project)}`, 'D',
      `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${fixture.bundle.length}`,
      ...writeCommands(TRANSACTION_ID, fixture.bundle),
      `F\t${TRANSACTION_ID}\t${fixture.manifest.snapshotManifestDigest}`,
      `A\t${TRANSACTION_ID}\t${finalName}\t${COMMITTED_AT}`,
      'X', '',
    ].join('\n'));
    assert.strictEqual(published.status, 0, published.stderr || published.stdout);
    const result = runLateTerminalMutation(
      paused,
      project,
      [`P\t${encodeHex(project)}`, 'D', 'L', 'X', ''].join('\n'),
      'committed-list-before-terminal',
      'receipt-duplicate'
    );
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(result.stdout.includes(`L\tITEM\t${SNAPSHOT_ID}\t`), false);
    assert.match(result.stdout, /L\tUNAVAILABLE\tsha256:[a-f0-9]{64}\tRECEIPT_UNAVAILABLE/);
    assert.strictEqual(fs.readdirSync(path.join(privateRoot, 'control')).filter(
      name => name.startsWith('receipt-')
    ).length, 2, 'foreign duplicate receipt must remain untouched');
  })
);

for (const mutation of ['receipt-delete', 'receipt-rewrite', 'receipt-replace', 'receipt-duplicate']) {
  test(`O terminal rejects late ${mutation} after exact bundle bytes were streamed`, () =>
    withScratch(scratch => {
      const normal = compileHelper(scratch);
      const paused = compileHelper(scratch, ['WRITCRAFT_TEST_PAUSE_COMMITTED_READ_BEFORE_TERMINAL']);
      const project = path.join(scratch, 'project');
      fs.mkdirSync(project);
      createPrivateTree(project);
      const fixture = createBundleFixture();
      const finalName = digestBasename('bundle-', SNAPSHOT_ID, '.wcsb');
      const published = runHelper(normal, project, [
        `P\t${encodeHex(project)}`, 'D',
        `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${fixture.bundle.length}`,
        ...writeCommands(TRANSACTION_ID, fixture.bundle),
        `F\t${TRANSACTION_ID}\t${fixture.manifest.snapshotManifestDigest}`,
        `A\t${TRANSACTION_ID}\t${finalName}\t${COMMITTED_AT}`,
        'X', '',
      ].join('\n'));
      assert.strictEqual(published.status, 0, published.stderr || published.stdout);
      const result = runLateTerminalMutation(
        paused,
        project,
        [`P\t${encodeHex(project)}`, 'D', `O\t${SNAPSHOT_ID}`, 'X', ''].join('\n'),
        'committed-read-before-terminal',
        mutation
      );
      assert.notStrictEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout.trim().split('\n').at(-1), /^O\tERR\t(?:IDENTITY|RECEIPT_UNAVAILABLE)$/);
      assert.strictEqual(result.stdout.includes('\nO\tOK\t'), false);
    })
  );
}

for (const mutation of ['leaf-delete', 'leaf-rewrite', 'leaf-replace']) {
  test(`O terminal rejects late ${mutation} after streaming from the held leaf`, () =>
    withScratch(scratch => {
      const normal = compileHelper(scratch);
      const paused = compileHelper(scratch, ['WRITCRAFT_TEST_PAUSE_COMMITTED_READ_BEFORE_TERMINAL']);
      const project = path.join(scratch, 'project');
      fs.mkdirSync(project);
      createPrivateTree(project);
      const fixture = createBundleFixture();
      const finalName = digestBasename('bundle-', SNAPSHOT_ID, '.wcsb');
      const published = runHelper(normal, project, [
        `P\t${encodeHex(project)}`, 'D',
        `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${fixture.bundle.length}`,
        ...writeCommands(TRANSACTION_ID, fixture.bundle),
        `F\t${TRANSACTION_ID}\t${fixture.manifest.snapshotManifestDigest}`,
        `A\t${TRANSACTION_ID}\t${finalName}\t${COMMITTED_AT}`,
        'X', '',
      ].join('\n'));
      assert.strictEqual(published.status, 0, published.stderr || published.stdout);
      const result = runLateTerminalMutation(
        paused,
        project,
        [`P\t${encodeHex(project)}`, 'D', `O\t${SNAPSHOT_ID}`, 'X', ''].join('\n'),
        'committed-read-before-terminal',
        mutation
      );
      assert.notStrictEqual(result.status, 0, result.stderr || result.stdout);
      assert.strictEqual(result.stdout.trim().split('\n').at(-1), 'O\tERR\tIDENTITY');
      assert.strictEqual(result.stdout.includes('\nO\tOK\t'), false);
    })
  );
}

for (const mutation of ['leaf-delete', 'leaf-replace']) {
  test(`L terminal reopens a late ${mutation} and never reports it available`, () =>
    withScratch(scratch => {
    const normal = compileHelper(scratch);
    const paused = compileHelper(scratch, ['WRITCRAFT_TEST_PAUSE_COMMITTED_LIST_BEFORE_TERMINAL']);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    createPrivateTree(project);
    const fixture = createBundleFixture();
    const finalName = digestBasename('bundle-', SNAPSHOT_ID, '.wcsb');
    const published = runHelper(normal, project, [
      `P\t${encodeHex(project)}`, 'D',
      `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${fixture.bundle.length}`,
      ...writeCommands(TRANSACTION_ID, fixture.bundle),
      `F\t${TRANSACTION_ID}\t${fixture.manifest.snapshotManifestDigest}`,
      `A\t${TRANSACTION_ID}\t${finalName}\t${COMMITTED_AT}`,
      'X', '',
    ].join('\n'));
    assert.strictEqual(published.status, 0, published.stderr || published.stdout);
    const result = runLateTerminalMutation(
      paused,
      project,
      [`P\t${encodeHex(project)}`, 'D', 'L', 'X', ''].join('\n'),
      'committed-list-before-terminal',
      mutation
    );
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(result.stdout.includes(`L\tITEM\t${SNAPSHOT_ID}\t`), false);
    assert.match(result.stdout, /L\tUNAVAILABLE\tsha256:[a-f0-9]{64}\tBUNDLE_UNAVAILABLE/);
    })
  );
}

test('L terminal revalidates canonical receipt identity after a late same-inode rewrite', () =>
  withScratch(scratch => {
    const normal = compileHelper(scratch);
    const paused = compileHelper(scratch, ['WRITCRAFT_TEST_PAUSE_COMMITTED_LIST_BEFORE_TERMINAL']);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    createPrivateTree(project);
    const fixture = createBundleFixture();
    const finalName = digestBasename('bundle-', SNAPSHOT_ID, '.wcsb');
    const published = runHelper(normal, project, [
      `P\t${encodeHex(project)}`, 'D',
      `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t${STAGE_NAME}\t${fixture.bundle.length}`,
      ...writeCommands(TRANSACTION_ID, fixture.bundle),
      `F\t${TRANSACTION_ID}\t${fixture.manifest.snapshotManifestDigest}`,
      `A\t${TRANSACTION_ID}\t${finalName}\t${COMMITTED_AT}`,
      'X', '',
    ].join('\n'));
    assert.strictEqual(published.status, 0, published.stderr || published.stdout);
    const result = runLateTerminalMutation(
      paused,
      project,
      [`P\t${encodeHex(project)}`, 'D', 'L', 'X', ''].join('\n'),
      'committed-list-before-terminal',
      'receipt-rewrite'
    );
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(result.stdout.includes(`L\tITEM\t${SNAPSHOT_ID}\t`), false);
    assert.match(result.stdout, /L\tUNAVAILABLE\tsha256:[a-f0-9]{64}\tRECEIPT_UNAVAILABLE/);
  })
);

test('list reports a corrupt private bundle as unavailable instead of an empty success', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const privateRoot = createPrivateTree(project);
    fs.writeFileSync(path.join(privateRoot, 'bundles', FINAL_NAME), 'corrupt', { mode: 0o600 });
    const result = runHelper(helper, project, [
      `P\t${encodeHex(project)}`,
      'D',
      'L',
      'X',
      '',
    ].join('\n'));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const lines = result.stdout.trim().split('\n');
    assert.match(lines[2], /^L\tUNAVAILABLE\tsha256:[a-f0-9]{64}\tBUNDLE_UNAVAILABLE$/);
    assert.strictEqual(lines[3], 'L\tOK\t0\t1\t1');
    assert.strictEqual(lines.some(line => line.includes(FINAL_NAME)), false);
  })
);

test('rejects a symlink component while binding the private absolute project path', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const realProject = path.join(scratch, 'real-project');
    const linkedProject = path.join(scratch, 'linked-project');
    fs.mkdirSync(realProject);
    createPrivateTree(realProject);
    fs.symlinkSync(realProject, linkedProject);
    const result = runHelper(helper, linkedProject, `P\t${encodeHex(linkedProject)}\n`);
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), 'P\tERR\tPATH');
  })
);

test('rejects oversized and malformed stage requests with stable path-free errors', () =>
  withScratch(scratch => {
    const helper = compileHelper(scratch);
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    createPrivateTree(project);
    const result = runHelper(helper, project, [
      `P\t${encodeHex(project)}`,
      'D',
      `S\t${TRANSACTION_ID}\t${SNAPSHOT_ID}\t../bad\t545259521`,
      '',
    ].join('\n'));
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim().split('\n').at(-1), 'S\tERR\tPROTOCOL');
    assert.ok(!result.stdout.includes(project));
  })
);

console.log(`\n${passed}/${passed} snapshot storage native helper checks passed.`);
