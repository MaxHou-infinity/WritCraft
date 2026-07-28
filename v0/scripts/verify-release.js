'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { once } = require('events');
const nativeHelperBuildService = require('./build-native-helper');
const { createProjectHashWorker } = require('../src/main/project-hash-worker');

const root = path.resolve(__dirname, '..');
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
const outputRoot = path.join(root, 'release', `WritCraft-darwin-${arch}`);
const app = path.join(outputRoot, 'WritCraft.app');
const zip = `${outputRoot}.zip`;
const packagedRoot = path.join(app, 'Contents', 'Resources', 'app');
const packagedHelper = path.join(app, 'Contents', 'Helpers', 'author-copy-helper');
const packagedProjectHashHelper = path.join(app, 'Contents', 'Helpers', 'project-hash-helper');
const builtHelper = path.join(root, 'src', 'main', 'native', 'author-copy-helper');
const builtProjectHashHelper = path.join(root, 'src', 'main', 'native', 'project-hash-helper');
const helperSource = path.join(root, 'native', 'author-copy-helper.c');
const projectHashHelperSource = path.join(root, 'native', 'project-hash-helper.c');
const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const PRODUCT_NAME = '笔触 · WritCraft';
const info = JSON.parse(fs.readFileSync(path.join(outputRoot, 'build-info.json'), 'utf8'));

const RELEASE_INFO_KEYS = Object.freeze([
  'schema', 'product', 'version', 'platform', 'arch', 'app', 'archive', 'archiveBytes', 'archiveSha256',
  'nativeHelperBuilds', 'minimumSystemVersion', 'signing', 'notarized',
]);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function sha256File(target) {
  return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function assertReleaseInfo() {
  assert(exactKeys(info, RELEASE_INFO_KEYS), 'release build-info contains an unknown or missing key');
  assert.strictEqual(info.schema, 'writcraft.release/v4');
  assert.strictEqual(info.product, PRODUCT_NAME);
  assert.strictEqual(info.version, sourcePackage.version);
  assert.strictEqual(info.platform, 'darwin');
  assert.strictEqual(info.arch, arch);
  assert.strictEqual(info.app, path.relative(root, app));
  assert.strictEqual(info.archive, path.relative(root, zip));
  assert.strictEqual(info.minimumSystemVersion, nativeHelperBuildService.MINIMUM_SYSTEM_VERSION);
  assert.strictEqual(info.signing, 'ad-hoc (local testing only)');
  assert.strictEqual(info.notarized, false);
  assert(exactKeys(info.nativeHelperBuilds, ['authorCopy', 'projectHash']));
  nativeHelperBuildService.assertNativeHelperAttestation(info.nativeHelperBuilds.authorCopy, {
    source: helperSource,
    output: builtHelper,
  });
  nativeHelperBuildService.assertNativeHelperAttestation(info.nativeHelperBuilds.projectHash, {
    source: projectHashHelperSource,
    output: builtProjectHashHelper,
  });
  assertArtifactHelperBinding(info.nativeHelperBuilds.authorCopy, packagedHelper);
  assertArtifactHelperBinding(info.nativeHelperBuilds.projectHash, packagedProjectHashHelper);
}

function assertArtifactHelperBinding(attestation, target) {
  return nativeHelperBuildService.assertArtifactHelperBinding(attestation, target);
}

function filesUnder(directory, prefix = '', options = {}) {
  const result = new Map();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (options.ignoreFinderMetadata && entry.name === '.DS_Store') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of filesUnder(absolute, relative, options)) result.set(key, value);
    } else if (entry.isFile()) {
      result.set(relative, sha256File(absolute));
    }
  }
  return result;
}

function treeSnapshot(directory, prefix = '', result = new Map()) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.set(relative, Object.freeze({
        type: 'directory',
        mode: Number(fs.lstatSync(absolute).mode & 0o777),
      }));
      treeSnapshot(absolute, relative, result);
    } else if (entry.isSymbolicLink()) {
      result.set(relative, Object.freeze({ type: 'symlink', target: fs.readlinkSync(absolute) }));
    } else if (entry.isFile()) {
      result.set(relative, Object.freeze({
        type: 'file',
        mode: Number(fs.lstatSync(absolute).mode & 0o777),
        sha256: sha256File(absolute),
      }));
    } else {
      throw new Error(`RELEASE_TREE_UNSUPPORTED_ENTRY:${relative}`);
    }
  }
  return result;
}

function assertTreeEqual(left, right) {
  assert.deepStrictEqual(treeSnapshot(left), treeSnapshot(right));
}

function minimalPdf(text = 'Packaged PDF source') {
  const escaped = text.replace(/([()\\])/g, '\\$1');
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Title (Release Verify) /Author (WritCraft) >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'binary');
}

function verifyMinimumSystemVersion(targetApp, helper) {
  const minimum = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :LSMinimumSystemVersion', path.join(targetApp, 'Contents', 'Info.plist')],
    { encoding: 'utf8' }
  ).trim();
  assert.strictEqual(minimum, '11.0');
  for (const architecture of ['arm64', 'x86_64']) {
    const build = execFileSync(
      'vtool',
      ['-show-build', '-arch', architecture, helper],
      { encoding: 'utf8' }
    );
    assert.match(build, /\bminos 11\.0\b/);
  }
}

function exercisePackagedHelper(helper, temporary) {
  fs.mkdirSync(temporary, { recursive: true });
  const sourceParent = path.join(temporary, 'source');
  const targetParent = path.join(temporary, 'target');
  fs.mkdirSync(sourceParent);
  fs.mkdirSync(targetParent);
  const sourceFd = fs.openSync(sourceParent, fs.constants.O_RDONLY);
  const targetFd = fs.openSync(targetParent, fs.constants.O_RDONLY);
  const receiptPath = path.join(temporary, '.reservation-receipt');
  const receiptFd = fs.openSync(
    receiptPath,
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600
  );
  fs.fchmodSync(receiptFd, 0o600);
  fs.unlinkSync(receiptPath);
  try {
    const run = request => spawnSync(helper, [], {
      input: JSON.stringify(request),
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe', sourceFd, targetFd, receiptFd],
    });
    const reserved = run({ mode: 'reserve' });
    assert.strictEqual(reserved.status, 0, reserved.stderr || reserved.stdout);
    const reservation = JSON.parse(reserved.stdout);
    assert.strictEqual(reservation.ok, true);
    fs.writeFileSync(path.join(sourceParent, reservation.name, 'proof.txt'), 'packaged helper proof');
    const published = run({
      mode: 'publish',
      source: reservation.name,
      target: 'published-copy',
      dev: reservation.dev,
      ino: reservation.ino,
    });
    assert.strictEqual(published.status, 0, published.stderr || published.stdout);
    assert.strictEqual(JSON.parse(published.stdout).expected, true);
    assert.strictEqual(
      fs.readFileSync(path.join(targetParent, 'published-copy', 'proof.txt'), 'utf8'),
      'packaged helper proof'
    );
  } finally {
    fs.closeSync(sourceFd);
    fs.closeSync(targetFd);
    fs.closeSync(receiptFd);
  }
}

function fileIdentity(target) {
  const stat = fs.lstatSync(target, { bigint: true });
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    nlink: stat.nlink,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  });
}

async function exerciseProjectHashHelper(helper, temporary) {
  const project = path.join(temporary, 'project');
  const directory = path.join(project, 'chapters');
  const target = path.join(directory, 'one.md');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(target, 'packaged project hash proof');
  const worker = createProjectHashWorker(project, { helperPath: helper });
  try {
    const leaf = fileIdentity(target);
    const results = await worker.hash([{
      relative: 'chapters/one.md',
      maxBytes: Number(leaf.size),
      identity: leaf,
      ancestors: [fileIdentity(directory)],
    }]);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].ok, true);
    assert.strictEqual(
      results[0].digest,
      crypto.createHash('sha256').update('packaged project hash proof').digest('hex').slice(0, 16)
    );
  } finally {
    const closed = worker.closed ? Promise.resolve() : once(worker.child, 'close');
    worker.close();
    await closed;
  }
}

console.log('\nWritCraft packaged release verification');

(async () => {
  await check('release manifest matches archive bytes and SHA-256', () => {
    assertReleaseInfo();
    assert.strictEqual(fs.statSync(zip).size, info.archiveBytes);
    assert.strictEqual(sha256File(zip), info.archiveSha256);
  });

  await check('ZIP and every nested helper have strict-valid local signatures', async () => {
    execFileSync('unzip', ['-tq', zip], { stdio: 'pipe' });
    const archiveEntries = execFileSync('unzip', ['-Z1', zip], {
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
    assert(!archiveEntries.some(entry => /(^|\/)\._/.test(entry)));
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
    execFileSync('codesign', ['--verify', '--strict', packagedHelper], { stdio: 'pipe' });
    execFileSync('codesign', ['--verify', '--strict', packagedProjectHashHelper], { stdio: 'pipe' });
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-release-zip-'));
    try {
      execFileSync('unzip', ['-q', zip, '-d', temporary], { stdio: 'pipe' });
      const extractedApp = path.join(temporary, 'WritCraft.app');
      const extractedHelper = path.join(
        extractedApp,
        'Contents',
        'Helpers',
        'author-copy-helper'
      );
      const extractedProjectHashHelper = path.join(
        extractedApp,
        'Contents',
        'Helpers',
        'project-hash-helper'
      );
      execFileSync('codesign', ['--verify', '--deep', '--strict', extractedApp], { stdio: 'pipe' });
      execFileSync('codesign', ['--verify', '--strict', extractedHelper], { stdio: 'pipe' });
      execFileSync('codesign', ['--verify', '--strict', extractedProjectHashHelper], { stdio: 'pipe' });
      assertArtifactHelperBinding(info.nativeHelperBuilds.authorCopy, extractedHelper);
      assertArtifactHelperBinding(info.nativeHelperBuilds.projectHash, extractedProjectHashHelper);
      assertTreeEqual(app, extractedApp);
      verifyMinimumSystemVersion(extractedApp, extractedHelper);
      verifyMinimumSystemVersion(extractedApp, extractedProjectHashHelper);
      exercisePackagedHelper(extractedHelper, path.join(temporary, 'transaction'));
      await exerciseProjectHashHelper(
        extractedProjectHashHelper,
        path.join(temporary, 'project-hash-transaction')
      );
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  await check('packaged application sources exactly match the current source tree', () => {
    const options = { ignoreFinderMetadata: true };
    const sourceFiles = filesUnder(path.join(root, 'src'), '', options);
    sourceFiles.delete('main/native/author-copy-helper');
    sourceFiles.delete('main/native/project-hash-helper');
    assert.deepStrictEqual(filesUnder(path.join(packagedRoot, 'src'), '', options), sourceFiles);
    assert.strictEqual(fs.existsSync(
      path.join(packagedRoot, 'src', 'main', 'native', 'author-copy-helper')
    ), false);
    assert.strictEqual(fs.existsSync(
      path.join(packagedRoot, 'src', 'main', 'native', 'project-hash-helper')
    ), false);
  });

  await check('package excludes secrets, environment files, tests, Python and macOS litter', () => {
    const files = [...filesUnder(packagedRoot).keys()];
    assert(!files.some(file => /(^|\/)\.env(?:\.|$)/.test(file)));
    assert(!files.some(file => /(^|\/)tests?(\/|$)/i.test(file)));
    assert(!files.some(file => /\.py[co]?$|(^|\/)\.DS_Store$/.test(file)));
    for (const relative of files.filter(file => /\.(?:js|json|html|md|txt)$/i.test(file))) {
      const content = fs.readFileSync(path.join(packagedRoot, ...relative.split('/')), 'utf8');
      assert(!/sk-(?:api|cp)-[A-Za-z0-9_-]{20,}/.test(content), `credential-shaped value in ${relative}`);
    }
  });

  await check('packaged PDF runtime extracts a real PDF without an external Python path', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-release-pdf-'));
    try {
      const source = path.join(temporary, 'source.pdf');
      fs.writeFileSync(source, minimalPdf());
      const extractor = require(path.join(packagedRoot, 'src', 'main', 'pdf-extract.js'));
      const result = await extractor.extractPdf(source, { maxPages: 5, maxChars: 20_000, timeoutMs: 10_000 });
      assert.strictEqual(result.pageCount, 1);
      assert.strictEqual(result.title, 'Release Verify');
      assert.strictEqual(result.author, 'WritCraft');
      assert(result.pages[0].text.includes('Packaged PDF source'));
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  await check('packaged native helpers are executable, universal and interpreter-free', () => {
    for (const helper of [packagedHelper, packagedProjectHashHelper]) {
      fs.accessSync(helper, fs.constants.R_OK | fs.constants.X_OK);
      const architectures = execFileSync('lipo', ['-archs', helper], {
        encoding: 'utf8',
      }).trim().split(/\s+/).sort();
      assert.deepStrictEqual(architectures, ['arm64', 'x86_64']);
      verifyMinimumSystemVersion(app, helper);
    }
    const service = fs.readFileSync(
      path.join(packagedRoot, 'src', 'main', 'author-acceptance-preflight-service.js'),
      'utf8'
    );
    assert.doesNotMatch(service, /python3|atomic-rename-exclusive\.py/);
  });

  await check('production manifest exposes no development scripts or dependencies', () => {
    const packaged = JSON.parse(fs.readFileSync(path.join(packagedRoot, 'package.json'), 'utf8'));
    assert.strictEqual(packaged.main, 'src/main/main.js');
    assert.strictEqual(packaged.scripts, undefined);
    assert.strictEqual(packaged.devDependencies, undefined);
    assert.strictEqual(packaged.dependencies, undefined);
  });

  console.log(`\n${passed}/7 packaged release checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
