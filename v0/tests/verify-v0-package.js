'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'scripts', 'package-macos.js'), 'utf8');
const nativeBuildScript = fs.readFileSync(path.join(root, 'scripts', 'build-native-helper.js'), 'utf8');
const releaseVerifyScript = fs.readFileSync(path.join(root, 'scripts', 'verify-release.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const nativeHelperBuild = require('../scripts/build-native-helper');
const packageMac = require('../scripts/package-macos');

console.log('\nmacOS packaging verification');

test('provides a local macOS release command without adding an installer dependency', () => {
  assert.strictEqual(packageJson.scripts['package:mac'], 'node scripts/package-macos.js');
  assert.strictEqual(packageJson.scripts['prepackage:mac'], undefined,
    'package script itself must own the native build; npm lifecycle hooks are bypassable');
  assert.match(script, /prepareNativeHelpers\(/,
    'direct node scripts/package-macos.js must establish fresh bindings for every native helper');
  assert(!/electron-builder|electron-packager|electron-forge/.test(JSON.stringify(packageJson)));
});

test('packages only production app sources and a sanitized production manifest', () => {
  assert.match(script, /fs\.cpSync\(path\.join\(root, 'src'\)/);
  assert.match(script, /productionPackage/);
  assert.doesNotMatch(script, /fs\.cpSync\([^\n]*(?:\.env|tests)/);
});

test('removes the Electron default app and assigns WritCraft bundle identity', () => {
  assert.match(script, /default_app\.asar/);
  assert.match(script, /verbatimSymlinks: true/);
  assert.match(script, /com\.maxhou\.writcraft/);
  assert.match(script, /CFBundleExecutable/);
});

test('ad-hoc signs, verifies, archives and records a SHA-256 release manifest', () => {
  assert.match(script, /codesign/);
  assert.match(script, /--verify/);
  assert.match(nativeBuildScript, /SIGNING_RECIPE/,
    'the attested recipe must include nested helper signing before its digest is recorded');
  assert.match(nativeBuildScript, /codesign/,
    'the build must sign the helper before creating its attestation');
  assert.match(script, /assertPackagedHelperBinding\(nativeHelperBuild, packagedNativeHelper\)/,
    'the package must reject a copied author helper whose bytes differ from the build attestation');
  assert.match(script, /assertPackagedHelperBinding\(projectHashHelperBuild, packagedProjectHashHelper\)/,
    'the package must reject a copied project-hash helper whose bytes differ from its build attestation');
  assert.doesNotMatch(script, /--sign', '-', packagedNativeHelper/,
    'package must not re-sign the nested helper after its attested build');
  assert.doesNotMatch(script, /--deep', '--sign', '-', outputApp/,
    'outer signing must not mutate the separately attested nested helper');
  assert.match(
    releaseVerifyScript,
    /assertArtifactHelperBinding\(info\.nativeHelperBuilds\.authorCopy, packagedHelper\)/,
    'release verification must bind the App author helper to its build digest'
  );
  assert.match(
    releaseVerifyScript,
    /assertArtifactHelperBinding\(info\.nativeHelperBuilds\.projectHash, packagedProjectHashHelper\)/,
    'release verification must bind the App project-hash helper to its build digest'
  );
  assert.match(
    releaseVerifyScript,
    /assertArtifactHelperBinding\(info\.nativeHelperBuilds\.authorCopy, extractedHelper\)/,
    'release verification must bind the extracted ZIP author helper to the same build digest'
  );
  assert.match(
    releaseVerifyScript,
    /assertArtifactHelperBinding\(info\.nativeHelperBuilds\.projectHash, extractedProjectHashHelper\)/,
    'release verification must bind the extracted ZIP project-hash helper to the same build digest'
  );
  assert.match(releaseVerifyScript, /assertTreeEqual\(app, extractedApp\)/,
    'release verification must compare the complete App and extracted ZIP trees');
  assert.match(releaseVerifyScript, /assert\.strictEqual\(info\.product, PRODUCT_NAME\)/,
    'release verification must pin the declared product identity');
  assert.match(releaseVerifyScript, /assert\.strictEqual\(info\.version, sourcePackage\.version\)/,
    'release verification must pin the packaged version to package.json');
  assert.match(releaseVerifyScript, /assert\.strictEqual\(info\.signing, 'ad-hoc \(local testing only\)'\)/,
    'release verification must reject a manifest that overclaims signing');
  assert.match(releaseVerifyScript, /assert\.strictEqual\(info\.notarized, false\)/,
    'release verification must reject a manifest that overclaims notarization');
  assert.match(releaseVerifyScript, /mode: Number\(fs\.lstatSync\(absolute\)\.mode & 0o777\)/,
    'release tree comparison must bind POSIX modes as well as bytes and symlinks');
  assert.match(script, /LSMinimumSystemVersion', '11\.0'/);
  assert.match(script, /ditto/);
  assert.match(script, /--norsrc/);
  assert.match(script, /archiveSha256/);
  assert.match(script, /nativeHelperBuilds/);
  assert.doesNotMatch(script, /nativeHelperPackagedSha256/,
    'the manifest must have one source-to-build digest, not an independent packaged digest');
  assert.match(script, /notarized: false/);
});

test('bundles the self-contained PDF runtime (pdfjs legacy build + standard fonts)', () => {
  assert.match(script, /pdfjs-dist/);
  assert.match(script, /legacy',\s*'build'/);
  assert.match(script, /standard_fonts/);
  // 提取服务不再依赖外部 python
  const service = fs.readFileSync(path.join(root, 'src', 'main', 'reference-import-service.js'), 'utf8');
  assert(!/execFile|python3|pypdf|pdfplumber\b/.test(service.replace(/\/\/[^\n]*/g, '')));
  assert.match(service, /require\('\.\/pdf-extract'\)/);
  // 独立提取模块存在且为 Node 内实现
  const extractor = fs.readFileSync(path.join(root, 'src', 'main', 'pdf-extract.js'), 'utf8');
  assert.match(extractor, /pdfjs-dist\/legacy\/build\/pdf\.mjs/);
  assert.match(extractor, /standardFontDataUrl/);
  // 旧 python helper 已删除
  assert(!fs.existsSync(path.join(root, 'src', 'main', 'pdf-extract-helper.py')));
});

test('bundles universal executable author-copy and project-hash helpers', () => {
  const authorHelper = path.join(root, 'src', 'main', 'native', 'author-copy-helper');
  const projectHashHelper = path.join(root, 'src', 'main', 'native', 'project-hash-helper');
  const service = fs.readFileSync(
    path.join(root, 'src', 'main', 'author-acceptance-preflight-service.js'),
    'utf8'
  );
  const worker = fs.readFileSync(
    path.join(root, 'src', 'main', 'project-hash-worker.js'),
    'utf8'
  );
  fs.accessSync(authorHelper, fs.constants.R_OK | fs.constants.X_OK);
  fs.accessSync(projectHashHelper, fs.constants.R_OK | fs.constants.X_OK);
  assert.match(script, /Author acceptance native helper/);
  assert.match(script, /Project hash native helper/);
  assert.match(script, /Contents', 'Helpers'/);
  assert.match(script, /author-copy-helper/);
  assert.match(script, /project-hash-helper/);
  assert.match(script, /fs\.rmSync\(path\.join\(packagedApp, 'src', 'main', 'native'/);
  assert.doesNotMatch(service, /python3|atomic-rename-exclusive\.py/);
  assert.match(service, /process\.resourcesPath/);
  assert.match(service, /'Helpers', 'author-copy-helper'/);
  assert.match(service, /native',\s*'author-copy-helper'/);
  assert.match(worker, /process\.resourcesPath/);
  assert.match(worker, /process\.resourcesPath && !process\.defaultApp/,
    'development Electron must use the source helper instead of Electron.app Contents/Helpers');
  assert.match(worker, /'Helpers', 'project-hash-helper'/);
  assert.match(worker, /native',\s*'project-hash-helper'/);
});

test('direct package path owns both current signed native build attestations and rejects stale proof', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-build-causality-'));
  const source = path.join(temporary, 'native', 'author-copy-helper.c');
  const output = path.join(temporary, 'src', 'main', 'native', 'author-copy-helper');
  const projectSource = path.join(temporary, 'native', 'project-hash-helper.c');
  const projectOutput = path.join(temporary, 'src', 'main', 'native', 'project-hash-helper');
  try {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(source, 'int main(void) { return 0; }\n');
    fs.writeFileSync(output, 'compiled-native-helper');
    fs.writeFileSync(projectSource, 'int main(void) { return 0; }\n');
    fs.writeFileSync(projectOutput, 'compiled-project-hash-helper');
    const attestation = nativeHelperBuild.createNativeHelperAttestation({ source, output });
    const projectAttestation = nativeHelperBuild.createNativeHelperAttestation({
      source: projectSource,
      output: projectOutput,
    });
    let calls = 0;
    const prepared = packageMac.prepareNativeHelper({
      root: temporary,
      source,
      output,
      buildNativeHelper(options) {
        calls += 1;
        assert.deepStrictEqual(options, { root: temporary });
        return attestation;
      },
    });
    assert.strictEqual(calls, 1, 'package must invoke its builder exactly once');
    assert.deepStrictEqual(prepared, attestation);

    let projectCalls = 0;
    const preparedProject = packageMac.prepareProjectHashHelper({
      root: temporary,
      source: projectSource,
      output: projectOutput,
      buildNativeHelper(options) {
        projectCalls += 1;
        assert.deepStrictEqual(options, {
          root: temporary,
          source: projectSource,
          output: projectOutput,
        });
        return projectAttestation;
      },
    });
    assert.strictEqual(projectCalls, 1, 'package must invoke the project-hash builder exactly once');
    assert.deepStrictEqual(preparedProject, projectAttestation);

    let coordinatorCalls = 0;
    assert.deepStrictEqual(packageMac.beginPackage({
      prepareNativeHelpers() {
        coordinatorCalls += 1;
        return Object.freeze({
          authorCopy: attestation,
          projectHash: projectAttestation,
        });
      },
    }), {
      authorCopy: attestation,
      projectHash: projectAttestation,
    });
    assert.strictEqual(coordinatorCalls, 1,
      'the production package coordinator must obtain exactly one dual-helper attestation set');

    assert.throws(() => packageMac.prepareNativeHelper({
      root: temporary,
      source,
      output,
      buildNativeHelper: () => ({ ...attestation, unexpected: true }),
    }), /NATIVE_HELPER_BUILD_ATTESTATION_INVALID/);

    fs.writeFileSync(output, 'stale-or-replaced-helper');
    assert.throws(() => packageMac.prepareNativeHelper({
      root: temporary,
      source,
      output,
      buildNativeHelper: () => attestation,
    }), /NATIVE_HELPER_BUILD_MISMATCH/);

    fs.writeFileSync(output, 'attested-helper-again');
    const freshAttestation = nativeHelperBuild.createNativeHelperAttestation({ source, output });
    const appHelper = path.join(temporary, 'app-helper');
    const extractedZipHelper = path.join(temporary, 'zip-helper');
    fs.copyFileSync(output, appHelper);
    fs.copyFileSync(output, extractedZipHelper);
    nativeHelperBuild.assertArtifactHelperBinding(freshAttestation, appHelper);
    nativeHelperBuild.assertArtifactHelperBinding(freshAttestation, extractedZipHelper);
    fs.writeFileSync(appHelper, 'tampered-app-helper');
    assert.throws(
      () => nativeHelperBuild.assertArtifactHelperBinding(freshAttestation, appHelper),
      /NATIVE_HELPER_ARTIFACT_MISMATCH/,
      'a tampered App helper must be rejected before archive creation'
    );
    fs.copyFileSync(output, appHelper);
    nativeHelperBuild.assertArtifactHelperBinding(freshAttestation, appHelper);

    const archiveRoot = path.join(temporary, 'archive-root');
    const oldZip = path.join(temporary, 'old-helper.zip');
    const unzipped = path.join(temporary, 'unzipped');
    const archivedHelper = path.join(
      archiveRoot, 'WritCraft.app', 'Contents', 'Helpers', 'author-copy-helper'
    );
    fs.mkdirSync(path.dirname(archivedHelper), { recursive: true });
    fs.writeFileSync(archivedHelper, 'old-zip-helper');
    execFileSync('zip', ['-qr', oldZip, 'WritCraft.app'], { cwd: archiveRoot });
    execFileSync('unzip', ['-q', oldZip, '-d', unzipped]);
    const extractedOldHelper = path.join(
      unzipped, 'WritCraft.app', 'Contents', 'Helpers', 'author-copy-helper'
    );
    assert.throws(
      () => nativeHelperBuild.assertArtifactHelperBinding(freshAttestation, extractedOldHelper),
      /NATIVE_HELPER_ARTIFACT_MISMATCH/,
      'a ZIP carrying an old helper must be rejected even when its App sibling is current'
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('full package coordinator builds both native helpers before writing its manifest', () => {
  let builds = 0;
  const info = packageMac.packageMac({
    prepareNativeHelpers() {
      const buildNativeHelper = options => {
        builds += 1;
        return nativeHelperBuild.buildNativeHelper(options);
      };
      return Object.freeze({
        authorCopy: packageMac.prepareNativeHelper({ buildNativeHelper }),
        projectHash: packageMac.prepareProjectHashHelper({ buildNativeHelper }),
      });
    },
  });
  assert.strictEqual(builds, 2,
    'one complete package invocation must build each native helper exactly once');
  assert.strictEqual(info.schema, 'writcraft.release/v4');
  assert.strictEqual(info.product, '笔触 · WritCraft');
  assert.strictEqual(info.version, packageJson.version);
  assert.deepStrictEqual(Object.keys(info.nativeHelperBuilds).sort(), ['authorCopy', 'projectHash']);
  assert.strictEqual(info.signing, 'ad-hoc (local testing only)');
  assert.strictEqual(info.notarized, false);
});

console.log(`\n${passed}/8 macOS packaging checks passed.`);
