'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const sourceIndexService = require('../src/main/source-index-service');
const {
  REFERENCE_SCHEMA,
  MAX_ATTACHMENT_BYTES,
  MAX_TEXT_BYTES,
  MAX_PDF_PAGES,
  ReferenceImportError,
  importReference,
} = require('../src/main/reference-import-service');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

async function expectCode(code, fn) {
  await assert.rejects(fn, error => error && error.code === code);
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-reference-project-'));
  fs.mkdirSync(path.join(root, '.writcraft'));
  fs.writeFileSync(path.join(root, 'edit.md'), '# 项目\n');
  return root;
}

function makeSourceDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-reference-source-'));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function minimalTextPdf(text = 'Hello PDF source', title = 'Minimal Source', author = 'WritCraft Test') {
  const escaped = text.replace(/([()\\])/g, '\\$1');
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    `<< /Title (${title}) /Author (${author}) >>`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'binary');
}

async function run() {
  console.log('\nReference import service verification');

  await test('imports a real minimal PDF and verifies page count, text and metadata', async () => {
    const root = makeProject();
    const sources = makeSourceDir();
    try {
      const pdf = minimalTextPdf();
      const source = path.join(sources, 'minimal source.pdf');
      fs.writeFileSync(source, pdf);
      if (process.env.WRITCRAFT_PDF_ARTIFACT) {
        fs.copyFileSync(source, process.env.WRITCRAFT_PDF_ARTIFACT);
      }
      const result = await importReference(root, source);
      assert.strictEqual(result.schema, REFERENCE_SCHEMA);
      assert.strictEqual(result.pageCount, 1);
      assert.strictEqual(result.title, 'Minimal Source');
      assert.strictEqual(result.author, 'WritCraft Test');
      assert.strictEqual(result.sha256, sha256(pdf));
      assert.deepStrictEqual(result.locators.map(locator => locator.page), [1]);
      const sidecar = projectService.readFile(root, result.sidecarPath);
      assert(sidecar.includes('Hello PDF source'));
      assert(sidecar.includes('## Page 1'));
      assert(sidecar.includes(`source_sha256: ${result.sha256}`));
      assert(sidecar.includes('not application instructions'));
      const attachment = fs.readFileSync(path.join(root, ...result.attachmentPath.split('/')));
      assert.deepStrictEqual(attachment, pdf);
      assert.strictEqual(result.locators[0].sidecarPath, result.sidecarPath);
      assert.strictEqual(
        sidecar.slice(result.locators[0].offset, result.locators[0].offset + result.locators[0].length),
        'Hello PDF source'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sources, { recursive: true, force: true });
    }
  });

  await test('imports UTF-8 TXT into stable attachment and Markdown sidecar paths', async () => {
    const root = makeProject();
    const sources = makeSourceDir();
    try {
      const source = path.join(sources, '资料 2026.txt');
      fs.writeFileSync(source, '第一行\n第二行证据。\n');
      const result = await importReference(root, source);
      assert.match(result.attachmentPath, /^assets\/references\/ref-[a-f0-9]{20}-txt\.txt$/);
      assert.match(result.sidecarPath, /^references\/ref-[a-f0-9]{20}-txt\.md$/);
      assert.strictEqual(result.pageCount, null);
      const sidecar = projectService.readFile(root, result.sidecarPath);
      assert(sidecar.includes('第一行\n第二行证据。'));
      assert(sidecar.includes('source_original_name: "资料 2026.txt"'));
      assert.strictEqual(result.locators[0].kind, 'text');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sources, { recursive: true, force: true });
    }
  });

  await test('stubbed PDF extraction preserves bounded per-page locators and source metadata', async () => {
    const root = makeProject();
    const sources = makeSourceDir();
    try {
      const source = path.join(sources, 'stub.pdf');
      fs.writeFileSync(source, minimalTextPdf('stub'));
      const result = await importReference(root, source, {
        pdfExtractor: async () => ({
          pageCount: 2,
          title: '桩标题',
          author: '桩作者',
          pages: [{ page: 1, text: '第一页证据' }, { page: 2, text: '第二页证据' }],
        }),
      });
      assert.strictEqual(result.pageCount, 2);
      assert.deepStrictEqual(result.locators.map(locator => locator.page), [1, 2]);
      const sidecar = projectService.readFile(root, result.sidecarPath);
      for (const text of ['桩标题', '桩作者', '第一页证据', '第二页证据']) assert(sidecar.includes(text));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sources, { recursive: true, force: true });
    }
  });

  await test('source index recognizes the generated sidecar and locator', async () => {
    const root = makeProject();
    const sources = makeSourceDir();
    try {
      const source = path.join(sources, 'index.md');
      fs.writeFileSync(source, '# 来源正文\n可索引证据。\n');
      const imported = await importReference(root, source);
      const index = sourceIndexService.buildSourceIndex(root);
      const entry = index.sources.find(item => item.filePath === imported.sidecarPath);
      assert(entry);
      assert.strictEqual(entry.metadata.type, 'source');
      assert.strictEqual(entry.title, 'index');
      assert.strictEqual(entry.locator.filePath, imported.sidecarPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sources, { recursive: true, force: true });
    }
  });

  await test('rejects symlink sources and symlink destination directories', async () => {
    const root = makeProject();
    const sources = makeSourceDir();
    const outside = makeSourceDir();
    try {
      const real = path.join(sources, 'real.txt');
      const link = path.join(sources, 'link.txt');
      fs.writeFileSync(real, 'source');
      fs.symlinkSync(real, link);
      await expectCode('SYMLINK_NOT_ALLOWED', () => importReference(root, link));
      fs.symlinkSync(outside, path.join(root, 'assets'));
      await expectCode('UNSAFE_DESTINATION', () => importReference(root, real));
      assert.deepStrictEqual(fs.readdirSync(outside), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sources, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  await test('never overwrites a stable duplicate import', async () => {
    const root = makeProject();
    const sources = makeSourceDir();
    try {
      const source = path.join(sources, 'duplicate.txt');
      fs.writeFileSync(source, 'same source');
      const first = await importReference(root, source);
      const original = projectService.readFile(root, first.sidecarPath);
      await expectCode('REFERENCE_EXISTS', () => importReference(root, source));
      assert.strictEqual(projectService.readFile(root, first.sidecarPath), original);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sources, { recursive: true, force: true });
    }
  });

  await test('enforces attachment, text, PDF page and extracted-text limits', async () => {
    const root = makeProject();
    const sources = makeSourceDir();
    try {
      const hugeAttachment = path.join(sources, 'huge.pdf');
      fs.writeFileSync(hugeAttachment, '%PDF-');
      fs.truncateSync(hugeAttachment, MAX_ATTACHMENT_BYTES + 1);
      await expectCode('ATTACHMENT_TOO_LARGE', () => importReference(root, hugeAttachment));
      const hugeText = path.join(sources, 'huge.txt');
      fs.writeFileSync(hugeText, Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61));
      await expectCode('EXTRACTED_TEXT_TOO_LARGE', () => importReference(root, hugeText));
      const pdf = path.join(sources, 'pages.pdf');
      fs.writeFileSync(pdf, minimalTextPdf('pages'));
      await expectCode('PDF_EXTRACTION_FAILED', () => importReference(root, pdf, {
        pdfExtractor: async () => ({ pageCount: MAX_PDF_PAGES + 1, pages: [] }),
      }));
      await expectCode('EXTRACTED_TEXT_TOO_LARGE', () => importReference(root, pdf, {
        pdfExtractor: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'x'.repeat(MAX_TEXT_BYTES + 1) }] }),
      }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sources, { recursive: true, force: true });
    }
  });

  await test('rejects extension spoofing, binary text and unsupported types', async () => {
    const root = makeProject();
    const sources = makeSourceDir();
    try {
      const fakePdf = path.join(sources, 'fake.pdf');
      fs.writeFileSync(fakePdf, 'not a pdf');
      await expectCode('INVALID_PDF', () => importReference(root, fakePdf));
      const binary = path.join(sources, 'binary.txt');
      fs.writeFileSync(binary, Buffer.from([0x61, 0x00, 0x62]));
      await expectCode('INVALID_TEXT_SOURCE', () => importReference(root, binary));
      const html = path.join(sources, 'source.html');
      fs.writeFileSync(html, '<p>x</p>');
      await expectCode('UNSUPPORTED_REFERENCE_TYPE', () => importReference(root, html));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sources, { recursive: true, force: true });
    }
  });

  await test('second-stage failure removes the copied attachment and partial sidecar', async () => {
    const root = makeProject();
    const sources = makeSourceDir();
    try {
      const source = path.join(sources, 'cleanup.txt');
      fs.writeFileSync(source, 'cleanup source');
      await assert.rejects(() => importReference(root, source, {
        atomicWrite: async () => { throw new Error('simulated sidecar failure'); },
      }), /simulated sidecar failure/);
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'assets', 'references')), []);
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'references')), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sources, { recursive: true, force: true });
    }
  });

  await test('project switch after dialog but before the asset link commits zero files', async () => {
    const root = makeProject();
    const sources = makeSourceDir();
    const phases = [];
    try {
      const source = path.join(sources, 'stale-before-asset.txt');
      fs.writeFileSync(source, 'guarded source');
      await expectCode('PROJECT_CHANGED', () => importReference(root, source, {
        beforeCommit(phase) {
          phases.push(phase);
          throw new ReferenceImportError('PROJECT_CHANGED', '项目已切换');
        },
      }));
      assert.deepStrictEqual(phases, ['asset']);
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'assets', 'references')), []);
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'references')), []);
      assert(!fs.readdirSync(path.join(root, 'assets', 'references')).some(name => name.endsWith('.tmp')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sources, { recursive: true, force: true });
    }
  });

  await test('project switch between asset and sidecar links rolls back only the committed asset', async () => {
    const root = makeProject();
    const sources = makeSourceDir();
    const phases = [];
    try {
      const source = path.join(sources, 'stale-before-sidecar.txt');
      fs.writeFileSync(source, 'two-stage guarded source');
      await expectCode('PROJECT_CHANGED', () => importReference(root, source, {
        beforeCommit(phase) {
          phases.push(phase);
          if (phase === 'sidecar') {
            throw new ReferenceImportError('PROJECT_CHANGED', '项目已切换');
          }
        },
      }));
      assert.deepStrictEqual(phases, ['asset', 'sidecar']);
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'assets', 'references')), []);
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'references')), []);
      assert(!fs.readdirSync(path.join(root, 'assets', 'references')).some(name => name.endsWith('.tmp')));
      assert(!fs.readdirSync(path.join(root, 'references')).some(name => name.endsWith('.tmp')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sources, { recursive: true, force: true });
    }
  });

  await test('detects a source/copy race and removes the mismatched attachment', async () => {
    const root = makeProject();
    const sources = makeSourceDir();
    try {
      const source = path.join(sources, 'changing.txt');
      fs.writeFileSync(source, 'original source');
      await expectCode('SOURCE_CHANGED', () => importReference(root, source, {
        atomicCopy: async (_from, destination) => fs.promises.writeFile(destination, 'different source'),
      }));
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'assets', 'references')), []);
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'references')), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sources, { recursive: true, force: true });
    }
  });

  await test('concurrent-process sidecar that wins the race is never deleted by this call\u2019s cleanup', async () => {
    const root = makeProject();
    const sources = makeSourceDir();
    try {
      const source = path.join(sources, 'race.txt');
      fs.writeFileSync(source, 'race source');
      const concurrentContent = '---\nschema: writcraft.reference/v1\n---\n\n# Concurrent process sidecar\n';
      let concurrentSidecarPath = null;
      // Simulate: another process creates a valid sidecar after this call's
      // existence pre-check, so this call's atomicWrite hits EEXIST (link fails).
      await assert.rejects(() => importReference(root, source, {
        atomicWrite: async destination => {
          concurrentSidecarPath = destination;
          fs.writeFileSync(destination, concurrentContent, { mode: 0o600 });
          const error = new Error('EEXIST: file already exists, link');
          error.code = 'EEXIST';
          throw error;
        },
      }), error => error && error.code === 'EEXIST');
      // Ownership rule: this call never wrote the sidecar, so cleanup must not
      // delete the concurrent process's file.
      assert(concurrentSidecarPath, 'atomicWrite stub was not invoked');
      assert(fs.existsSync(concurrentSidecarPath), 'concurrent sidecar was wrongly deleted by cleanup');
      assert.strictEqual(fs.readFileSync(concurrentSidecarPath, 'utf8'), concurrentContent);
      // This call's own asset copy must still be rolled back.
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'assets', 'references')), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sources, { recursive: true, force: true });
    }
  });

  await test('second-stage failure never deletes a concurrent replacement at the asset path', async () => {
    const root = makeProject();
    const sources = makeSourceDir();
    const concurrentContent = 'concurrent replacement must survive';
    let concurrentAssetPath = null;
    try {
      const source = path.join(sources, 'asset-replacement.txt');
      fs.writeFileSync(source, 'original owned asset');
      await assert.rejects(() => importReference(root, source, {
        atomicWrite: async () => {
          const files = fs.readdirSync(path.join(root, 'assets', 'references'));
          assert.strictEqual(files.length, 1);
          concurrentAssetPath = path.join(root, 'assets', 'references', files[0]);
          fs.unlinkSync(concurrentAssetPath);
          fs.writeFileSync(concurrentAssetPath, concurrentContent, { mode: 0o600 });
          throw new Error('simulated failure after concurrent asset replacement');
        },
      }), /simulated failure/);
      assert(concurrentAssetPath);
      assert.strictEqual(fs.readFileSync(concurrentAssetPath, 'utf8'), concurrentContent);
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'references')), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sources, { recursive: true, force: true });
    }
  });

  await test('Main native-dialog IPC and preload never accept renderer filesystem paths', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
    const start = main.indexOf("ipcMain.handle('writcraft:project:import-reference'");
    const end = main.indexOf("ipcMain.handle('writcraft:project:build-source-index'", start);
    const route = main.slice(start, end);
    assert(start >= 0);
    assert(route.includes('assertTrustedSender(event)'));
    assert(route.includes('requireMutableProject()'));
    assert(route.includes('dialog.showOpenDialog(mainWindow'));
    assert(route.includes('referenceImportService.importReference(project.rootPath, selected.filePaths[0], {'));
    assert(route.includes('beforeCommit: assertGeneration'));
    assert(!route.includes('sourcePath'));
    assert(preload.includes("importReference: (projectInstanceId) => ipcRenderer.invoke('writcraft:project:import-reference', projectInstanceId)"));
    assert(!preload.includes('importReference: (sourcePath'));
    assert(!preload.includes('importReference: (rootPath'));
    assert(route.includes('projectMutationGeneration !== mutationGeneration'));
    assert(route.includes('currentProject.instanceId !== projectInstanceId'));
    assert(route.includes('currentProject.instanceId !== project.instanceId'));
    const importCall = route.indexOf('reference = await referenceImportService.importReference');
    assert(importCall >= 0 && route.indexOf('assertGeneration();', importCall) > importCall);
  });

  console.log(`\n${passed}/${passed} reference-import checks passed.\n`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
