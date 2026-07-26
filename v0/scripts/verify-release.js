'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
const outputRoot = path.join(root, 'release', `WritCraft-darwin-${arch}`);
const app = path.join(outputRoot, 'WritCraft.app');
const zip = `${outputRoot}.zip`;
const packagedRoot = path.join(app, 'Contents', 'Resources', 'app');
const info = JSON.parse(fs.readFileSync(path.join(outputRoot, 'build-info.json'), 'utf8'));

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

console.log('\nWritCraft packaged release verification');

(async () => {
  await check('release manifest matches archive bytes and SHA-256', () => {
    assert.strictEqual(info.schema, 'writcraft.release/v1');
    assert.strictEqual(fs.statSync(zip).size, info.archiveBytes);
    assert.strictEqual(sha256File(zip), info.archiveSha256);
  });

  await check('ZIP structure is readable and the app has a strict-valid local signature', () => {
    execFileSync('unzip', ['-tq', zip], { stdio: 'pipe' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
  });

  await check('packaged application sources exactly match the current source tree', () => {
    const options = { ignoreFinderMetadata: true };
    assert.deepStrictEqual(filesUnder(path.join(packagedRoot, 'src'), '', options), filesUnder(path.join(root, 'src'), '', options));
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

  await check('production manifest exposes no development scripts or dependencies', () => {
    const packaged = JSON.parse(fs.readFileSync(path.join(packagedRoot, 'package.json'), 'utf8'));
    assert.strictEqual(packaged.main, 'src/main/main.js');
    assert.strictEqual(packaged.scripts, undefined);
    assert.strictEqual(packaged.devDependencies, undefined);
    assert.strictEqual(packaged.dependencies, undefined);
  });

  console.log(`\n${passed}/6 packaged release checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
