'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronApp = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
const releaseRoot = path.join(root, 'release');
const outputRoot = path.join(releaseRoot, `WritCraft-darwin-${arch}`);
const outputApp = path.join(outputRoot, 'WritCraft.app');
const resources = path.join(outputApp, 'Contents', 'Resources');
const packagedApp = path.join(resources, 'app');
const plist = path.join(outputApp, 'Contents', 'Info.plist');
const oldExecutable = path.join(outputApp, 'Contents', 'MacOS', 'Electron');
const executable = path.join(outputApp, 'Contents', 'MacOS', 'WritCraft');
const zipPath = `${outputRoot}.zip`;

function required(target, label) {
  if (!fs.existsSync(target)) throw new Error(`${label} 不存在：${target}`);
}

function sha256(target) {
  return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
}

required(electronApp, 'Electron macOS runtime');
required(path.join(root, 'src', 'main', 'main.js'), 'WritCraft main process');

fs.mkdirSync(releaseRoot, { recursive: true });
fs.rmSync(outputRoot, { recursive: true, force: true });
fs.rmSync(zipPath, { force: true });
fs.mkdirSync(outputRoot, { recursive: true });
fs.cpSync(electronApp, outputApp, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
fs.mkdirSync(packagedApp, { recursive: true });
fs.cpSync(path.join(root, 'src'), path.join(packagedApp, 'src'), { recursive: true, preserveTimestamps: true });

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

// Ad-hoc signing makes local distribution internally consistent. A future
// public release still needs a Developer ID identity and Apple notarization.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', outputApp], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', outputApp], { stdio: 'inherit' });
execFileSync('ditto', ['-c', '-k', '--keepParent', outputApp, zipPath]);

const info = {
  schema: 'writcraft.release/v1',
  product: '笔触 · WritCraft',
  version: sourcePackage.version,
  platform: 'darwin',
  arch,
  app: path.relative(root, outputApp),
  archive: path.relative(root, zipPath),
  archiveBytes: fs.statSync(zipPath).size,
  archiveSha256: sha256(zipPath),
  signing: 'ad-hoc (local testing only)',
  notarized: false,
};
fs.writeFileSync(path.join(outputRoot, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify(info, null, 2));
