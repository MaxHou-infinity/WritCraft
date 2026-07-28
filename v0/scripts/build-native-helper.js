'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ATTESTATION_SCHEMA = 'writcraft.native-helper-build/v1';
const ARCHITECTURES = Object.freeze(['arm64', 'x86_64']);
const MINIMUM_SYSTEM_VERSION = '11.0';
const SIGNING_RECIPE = Object.freeze({
  executable: 'codesign',
  arguments: Object.freeze(['--force', '--sign', '-', '<output>']),
  verificationArguments: Object.freeze(['--verify', '--strict', '<output>']),
});
const BUILD_RECIPE = Object.freeze({
  compiler: 'xcrun',
  arguments: Object.freeze([
    '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
    `-mmacosx-version-min=${MINIMUM_SYSTEM_VERSION}`,
    '-arch', 'arm64', '-arch', 'x86_64', '<source>', '-o', '<output>',
  ]),
  signing: SIGNING_RECIPE,
});
const ATTESTATION_KEYS = Object.freeze([
  'schema', 'sourceSha256', 'binarySha256', 'recipeSha256', 'architectures', 'minimumSystemVersion',
]);

function sha256File(target, fileSystem = fs) {
  return crypto.createHash('sha256').update(fileSystem.readFileSync(target)).digest('hex');
}

function recipeSha256() {
  return crypto.createHash('sha256').update(JSON.stringify(BUILD_RECIPE)).digest('hex');
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function createNativeHelperAttestation({ source, output, fileSystem = fs }) {
  return Object.freeze({
    schema: ATTESTATION_SCHEMA,
    sourceSha256: sha256File(source, fileSystem),
    binarySha256: sha256File(output, fileSystem),
    recipeSha256: recipeSha256(),
    architectures: Object.freeze([...ARCHITECTURES]),
    minimumSystemVersion: MINIMUM_SYSTEM_VERSION,
  });
}

function assertAttestationShape(attestation) {
  if (!exactKeys(attestation, ATTESTATION_KEYS) ||
      attestation.schema !== ATTESTATION_SCHEMA ||
      !/^[a-f0-9]{64}$/.test(attestation.sourceSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(attestation.binarySha256 || '') ||
      attestation.recipeSha256 !== recipeSha256() ||
      !Array.isArray(attestation.architectures) ||
      attestation.architectures.length !== ARCHITECTURES.length ||
      attestation.architectures.some((architecture, index) => architecture !== ARCHITECTURES[index]) ||
      attestation.minimumSystemVersion !== MINIMUM_SYSTEM_VERSION) {
    throw new Error('NATIVE_HELPER_BUILD_ATTESTATION_INVALID');
  }
}

function assertNativeHelperAttestation(attestation, { source, output, fileSystem = fs }) {
  assertAttestationShape(attestation);
  if (!fileSystem.existsSync(source) || !fileSystem.existsSync(output) ||
      sha256File(source, fileSystem) !== attestation.sourceSha256 ||
      sha256File(output, fileSystem) !== attestation.binarySha256) {
    throw new Error('NATIVE_HELPER_BUILD_MISMATCH');
  }
  return Object.freeze({
    schema: attestation.schema,
    sourceSha256: attestation.sourceSha256,
    binarySha256: attestation.binarySha256,
    recipeSha256: attestation.recipeSha256,
    architectures: Object.freeze([...attestation.architectures]),
    minimumSystemVersion: attestation.minimumSystemVersion,
  });
}

function assertArtifactHelperBinding(attestation, target, fileSystem = fs) {
  assertAttestationShape(attestation);
  if (!fileSystem.existsSync(target) ||
      sha256File(target, fileSystem) !== attestation.binarySha256) {
    throw new Error('NATIVE_HELPER_ARTIFACT_MISMATCH');
  }
  return attestation.binarySha256;
}

function buildNativeHelper(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const projectRoot = options.root || path.resolve(__dirname, '..');
  const source = options.source || path.join(projectRoot, 'native', 'author-copy-helper.c');
  const outputDirectory = options.outputDirectory || path.join(projectRoot, 'src', 'main', 'native');
  const output = options.output || path.join(outputDirectory, 'author-copy-helper');

  if ((options.platform || process.platform) !== 'darwin') {
    throw new Error('author-copy-helper 只能在 macOS 构建');
  }
  if (!fileSystem.existsSync(source)) throw new Error('author-copy-helper 源码不存在');

  fileSystem.mkdirSync(outputDirectory, { recursive: true });
  execFileSync('xcrun', [
    '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
    `-mmacosx-version-min=${MINIMUM_SYSTEM_VERSION}`,
    '-arch', 'arm64', '-arch', 'x86_64', source, '-o', output,
  ], { stdio: 'inherit' });
  fileSystem.chmodSync(output, 0o755);
  execFileSync('lipo', [output, '-verify_arch', ...ARCHITECTURES]);
  execFileSync(SIGNING_RECIPE.executable, [
    '--force', '--sign', '-', output,
  ], { stdio: 'inherit' });
  execFileSync(SIGNING_RECIPE.executable, [
    '--verify', '--strict', output,
  ], { stdio: 'inherit' });
  return createNativeHelperAttestation({ source, output, fileSystem });
}

if (require.main === module) {
  const attestation = buildNativeHelper();
  console.log(JSON.stringify(attestation, null, 2));
}

module.exports = Object.freeze({
  ATTESTATION_SCHEMA,
  ATTESTATION_KEYS,
  ARCHITECTURES,
  MINIMUM_SYSTEM_VERSION,
  BUILD_RECIPE,
  recipeSha256,
  createNativeHelperAttestation,
  assertNativeHelperAttestation,
  assertArtifactHelperBinding,
  buildNativeHelper,
});
