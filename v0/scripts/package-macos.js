'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const nativeHelperBuildService = require('./build-native-helper');

const root = path.resolve(__dirname, '..');
const electronApp = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
const releaseRoot = path.join(root, 'release');
const outputRoot = path.join(releaseRoot, `WritCraft-darwin-${arch}`);
const outputApp = path.join(outputRoot, 'WritCraft.app');
const resources = path.join(outputApp, 'Contents', 'Resources');
const helpers = path.join(outputApp, 'Contents', 'Helpers');
const packagedApp = path.join(resources, 'app');
const plist = path.join(outputApp, 'Contents', 'Info.plist');
const oldExecutable = path.join(outputApp, 'Contents', 'MacOS', 'Electron');
const executable = path.join(outputApp, 'Contents', 'MacOS', 'WritCraft');
const nativeHelper = path.join(root, 'src', 'main', 'native', 'author-copy-helper');
const packagedNativeHelper = path.join(helpers, 'author-copy-helper');
const writingStructureHelper = path.join(root, 'src', 'main', 'native', 'writing-structure-helper');
const packagedWritingStructureHelper = path.join(helpers, 'writing-structure-helper');
const projectHashHelper = path.join(root, 'src', 'main', 'native', 'project-hash-helper');
const packagedProjectHashHelper = path.join(helpers, 'project-hash-helper');
const markdownTrashHelper = path.join(root, 'src', 'main', 'native', 'markdown-trash-helper');
const packagedMarkdownTrashHelper = path.join(helpers, 'markdown-trash-helper');
const zipPath = `${outputRoot}.zip`;

function required(target, label) {
  if (!fs.existsSync(target)) throw new Error(`${label} 不存在：${target}`);
}

function sha256(target) {
  return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
}

function prepareNativeHelper(options = {}) {
  const projectRoot = options.root || root;
  const source = options.source || path.join(projectRoot, 'native', 'author-copy-helper.c');
  const output = options.output || path.join(projectRoot, 'src', 'main', 'native', 'author-copy-helper');
  const buildNativeHelper = options.buildNativeHelper || nativeHelperBuildService.buildNativeHelper;
  // This is deliberately owned by package-macos itself. `prepackage` hooks do
  // not run when this script is invoked directly, so they cannot be the proof
  // that the copied native executable came from the current C source.
  const attestation = buildNativeHelper({ root: projectRoot });
  return nativeHelperBuildService.assertNativeHelperAttestation(attestation, { source, output });
}

function prepareProjectHashHelper(options = {}) {
  const projectRoot = options.root || root;
  const source = options.source || path.join(projectRoot, 'native', 'project-hash-helper.c');
  const output = options.output || path.join(projectRoot, 'src', 'main', 'native', 'project-hash-helper');
  const buildNativeHelper = options.buildNativeHelper || nativeHelperBuildService.buildNativeHelper;
  const attestation = buildNativeHelper({ root: projectRoot, source, output });
  return nativeHelperBuildService.assertNativeHelperAttestation(attestation, { source, output });
}

function prepareWritingStructureHelper(options = {}) {
  const projectRoot = options.root || root;
  const source = options.source || path.join(projectRoot, 'native', 'writing-structure-helper.c');
  const output = options.output || path.join(projectRoot, 'src', 'main', 'native', 'writing-structure-helper');
  const buildNativeHelper = options.buildNativeHelper || nativeHelperBuildService.buildNativeHelper;
  const attestation = buildNativeHelper({ root: projectRoot, source, output });
  return nativeHelperBuildService.assertNativeHelperAttestation(attestation, { source, output });
}

function prepareMarkdownTrashHelper(options = {}) {
  const projectRoot = options.root || root;
  const source = options.source || path.join(projectRoot, 'native', 'markdown-trash-helper.c');
  const output = options.output || path.join(projectRoot, 'src', 'main', 'native', 'markdown-trash-helper');
  const buildNativeHelper = options.buildNativeHelper || nativeHelperBuildService.buildNativeHelper;
  const attestation = buildNativeHelper({ root: projectRoot, source, output });
  return nativeHelperBuildService.assertNativeHelperAttestation(attestation, { source, output });
}

function prepareNativeHelpers(options = {}) {
  return Object.freeze({
    authorCopy: (options.prepareAuthorCopy || prepareNativeHelper)(options.authorCopy || {}),
    writingStructure: (
      options.prepareWritingStructure || prepareWritingStructureHelper
    )(options.writingStructure || {}),
    projectHash: (options.prepareProjectHash || prepareProjectHashHelper)(options.projectHash || {}),
    markdownTrash: (options.prepareMarkdownTrash || prepareMarkdownTrashHelper)(options.markdownTrash || {}),
  });
}

function beginPackage(options = {}) {
  const prepare = options.prepareNativeHelpers || prepareNativeHelpers;
  return prepare();
}

function assertPackagedHelperBinding(attestation, target = packagedNativeHelper) {
  return nativeHelperBuildService.assertArtifactHelperBinding(attestation, target);
}

function signElectronRuntimeBundles() {
  const frameworks = path.join(outputApp, 'Contents', 'Frameworks');
  for (const entry of fs.readdirSync(frameworks, { withFileTypes: true })
    .filter(candidate => candidate.isDirectory() && /\.(?:app|framework|xpc)$/.test(candidate.name))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    // Repair Electron's own nested code only. The separately attested author
    // helper lives in Contents/Helpers and must never be re-signed here.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', path.join(frameworks, entry.name)], {
      stdio: 'inherit',
    });
  }
}

function packageMac(options = {}) {
  // Exactly one build is permitted per package invocation. The returned
  // attestation is rechecked before any copy/sign/archive operation.
  const nativeHelperBuilds = beginPackage(options);
  const nativeHelperBuild = nativeHelperBuilds.authorCopy;
  const writingStructureHelperBuild = nativeHelperBuilds.writingStructure;
  const projectHashHelperBuild = nativeHelperBuilds.projectHash;
  const markdownTrashHelperBuild = nativeHelperBuilds.markdownTrash;
  required(electronApp, 'Electron macOS runtime');
  required(path.join(root, 'src', 'main', 'main.js'), 'WritCraft main process');
  required(nativeHelper, 'Author acceptance native helper');
  required(writingStructureHelper, 'Writing structure native helper');
  required(projectHashHelper, 'Project hash native helper');
  required(markdownTrashHelper, 'Markdown trash native helper');

fs.mkdirSync(releaseRoot, { recursive: true });
fs.rmSync(outputRoot, { recursive: true, force: true });
fs.rmSync(zipPath, { force: true });
fs.mkdirSync(outputRoot, { recursive: true });
fs.cpSync(electronApp, outputApp, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
fs.mkdirSync(packagedApp, { recursive: true });
fs.cpSync(path.join(root, 'src'), path.join(packagedApp, 'src'), { recursive: true, preserveTimestamps: true });
fs.mkdirSync(helpers, { recursive: true });
fs.copyFileSync(nativeHelper, packagedNativeHelper);
fs.chmodSync(packagedNativeHelper, 0o755);
assertPackagedHelperBinding(nativeHelperBuild, packagedNativeHelper);
fs.copyFileSync(writingStructureHelper, packagedWritingStructureHelper);
fs.chmodSync(packagedWritingStructureHelper, 0o755);
assertPackagedHelperBinding(writingStructureHelperBuild, packagedWritingStructureHelper);
fs.copyFileSync(projectHashHelper, packagedProjectHashHelper);
fs.chmodSync(packagedProjectHashHelper, 0o755);
assertPackagedHelperBinding(projectHashHelperBuild, packagedProjectHashHelper);
fs.copyFileSync(markdownTrashHelper, packagedMarkdownTrashHelper);
fs.chmodSync(packagedMarkdownTrashHelper, 0o755);
assertPackagedHelperBinding(markdownTrashHelperBuild, packagedMarkdownTrashHelper);
fs.rmSync(path.join(packagedApp, 'src', 'main', 'native', 'author-copy-helper'));
fs.rmSync(path.join(packagedApp, 'src', 'main', 'native', 'writing-structure-helper'));
fs.rmSync(path.join(packagedApp, 'src', 'main', 'native', 'project-hash-helper'));
fs.rmSync(path.join(packagedApp, 'src', 'main', 'native', 'markdown-trash-helper'));

function removeFinderMetadata(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.name === '.DS_Store') fs.rmSync(target, { force: true });
    else if (entry.isDirectory()) removeFinderMetadata(target);
  }
}
removeFinderMetadata(packagedApp);

// 运行时依赖：PDF 提取（pdfjs-dist legacy build + 标准字体）。
// 只复制运行必需子集，保持包体积小且自包含（干净 Mac 无 python 也能导入 PDF）。
const pdfjsSource = path.join(root, 'node_modules', 'pdfjs-dist');
required(path.join(pdfjsSource, 'legacy', 'build', 'pdf.mjs'), 'pdfjs-dist legacy build');
const pdfjsDestination = path.join(packagedApp, 'node_modules', 'pdfjs-dist');
fs.mkdirSync(path.join(pdfjsDestination, 'legacy'), { recursive: true });
fs.cpSync(path.join(pdfjsSource, 'legacy', 'build'), path.join(pdfjsDestination, 'legacy', 'build'), { recursive: true, preserveTimestamps: true });
fs.cpSync(path.join(pdfjsSource, 'standard_fonts'), path.join(pdfjsDestination, 'standard_fonts'), { recursive: true, preserveTimestamps: true });
fs.copyFileSync(path.join(pdfjsSource, 'package.json'), path.join(pdfjsDestination, 'package.json'));
fs.copyFileSync(path.join(pdfjsSource, 'LICENSE'), path.join(pdfjsDestination, 'LICENSE'));

const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const productionPackage = {
  name: sourcePackage.name,
  productName: '笔触 · WritCraft',
  version: sourcePackage.version,
  description: sourcePackage.description,
  main: sourcePackage.main,
  author: sourcePackage.author,
  license: sourcePackage.license,
};
fs.writeFileSync(path.join(packagedApp, 'package.json'), `${JSON.stringify(productionPackage, null, 2)}\n`, { mode: 0o644 });

if (fs.existsSync(oldExecutable)) fs.renameSync(oldExecutable, executable);
fs.chmodSync(executable, 0o755);
const plistBuddy = '/usr/libexec/PlistBuddy';
for (const [key, value] of [
  ['CFBundleDisplayName', '笔触 · WritCraft'],
  ['CFBundleName', 'WritCraft'],
  ['CFBundleIdentifier', 'com.maxhou.writcraft'],
  ['CFBundleExecutable', 'WritCraft'],
  ['CFBundleShortVersionString', sourcePackage.version],
  ['CFBundleVersion', sourcePackage.version],
  ['LSMinimumSystemVersion', '11.0'],
]) {
  execFileSync(plistBuddy, ['-c', `Set :${key} ${value}`, plist]);
}
execFileSync(plistBuddy, ['-c', 'Set :LSApplicationCategoryType public.app-category.productivity', plist]);
for (const key of [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'ElectronAsarIntegrity',
]) {
  try { execFileSync(plistBuddy, ['-c', `Delete :${key}`, plist], { stdio: 'ignore' }); } catch (_) {}
}
try {
  execFileSync(plistBuddy, ['-c', 'Set :NSAppTransportSecurity:NSAllowsArbitraryLoads false', plist]);
} catch (_) {}

// The helper was signed in build-native-helper before its SHA-256 was
// attested. Package only copies and verifies it; re-signing here would create
// a different binary than the one the build attestation binds.
signElectronRuntimeBundles();
execFileSync('codesign', ['--verify', '--strict', packagedNativeHelper], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--strict', packagedWritingStructureHelper], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--strict', packagedProjectHashHelper], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--strict', packagedMarkdownTrashHelper], { stdio: 'inherit' });
execFileSync('codesign', ['--force', '--sign', '-', outputApp], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--strict', packagedNativeHelper], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--strict', packagedWritingStructureHelper], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--strict', packagedProjectHashHelper], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--strict', packagedMarkdownTrashHelper], { stdio: 'inherit' });
assertPackagedHelperBinding(nativeHelperBuild, packagedNativeHelper);
assertPackagedHelperBinding(writingStructureHelperBuild, packagedWritingStructureHelper);
assertPackagedHelperBinding(projectHashHelperBuild, packagedProjectHashHelper);
assertPackagedHelperBinding(markdownTrashHelperBuild, packagedMarkdownTrashHelper);
execFileSync('codesign', ['--verify', '--deep', '--strict', outputApp], { stdio: 'inherit' });
execFileSync('ditto', ['-c', '-k', '--norsrc', '--keepParent', outputApp, zipPath]);

const info = {
  schema: 'writcraft.release/v4',
  product: '笔触 · WritCraft',
  version: sourcePackage.version,
  platform: 'darwin',
  arch,
  app: path.relative(root, outputApp),
  archive: path.relative(root, zipPath),
  archiveBytes: fs.statSync(zipPath).size,
  archiveSha256: sha256(zipPath),
  nativeHelperBuilds,
  minimumSystemVersion: '11.0',
  signing: 'ad-hoc (local testing only)',
  notarized: false,
};
fs.writeFileSync(path.join(outputRoot, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify(info, null, 2));
return info;
}

if (require.main === module) packageMac();

module.exports = Object.freeze({
  prepareNativeHelper,
  prepareWritingStructureHelper,
  prepareProjectHashHelper,
  prepareMarkdownTrashHelper,
  prepareNativeHelpers,
  beginPackage,
  assertPackagedHelperBinding,
  packageMac,
});
