#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const service = require('../src/main/author-acceptance-preflight-service');
const fixture = require('./fixtures/writcraft-longform-project');
const cli = require('../scripts/prepare-author-acceptance');

console.log('\nWritCraft author acceptance preflight verification');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function withScratch(fn) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-author-preflight-'));
  try {
    return fn(scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function isAuthorCopyHelper(command) {
  return String(command || '').endsWith('/native/author-copy-helper');
}

function buildEligible(scratch, name = '作者验收项目') {
  return fixture.buildLongformProject({ parentPath: scratch, projectService, name });
}

function flattenedKeys(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    output.push(key);
    flattenedKeys(child, output);
  }
  return output;
}

function isReadOnlyOpen(flags) {
  return typeof flags === 'number' &&
    (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0;
}

function snapshotProject(rootPath) {
  const scan = service.scanProjectTree(rootPath);
  return {
    digest: scan.snapshotDigest,
    files: new Map(scan.files.map(file => [file.relative, file.digest])),
  };
}

test('accepts a five-plus chapter, 2000-plus Chinese character project with edit.md and sources', () =>
  withScratch(scratch => {
    const project = buildEligible(scratch);
    const report = service.inspectProject(project.rootPath);
    assert.strictEqual(report.schema, service.PREFLIGHT_SCHEMA);
    assert.strictEqual(report.eligible, true);
    assert(report.checks.chapterFileCount >= 5);
    assert(report.checks.visibleChineseChars >= 2000);
    assert(report.checks.sourceFileCount >= 1);
    assert.strictEqual(report.checks.editPromptStatus, 'valid');
    assert.deepStrictEqual(report.errors, []);
    assert(/^[a-f0-9]{64}$/.test(report.snapshotDigest));
  })
);

test('ships one executable universal native helper with no Python runtime dependency', () => {
  const helper = path.join(__dirname, '..', 'src', 'main', 'native', 'author-copy-helper');
  const serviceSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'author-acceptance-preflight-service.js'),
    'utf8'
  );
  fs.accessSync(helper, fs.constants.R_OK | fs.constants.X_OK);
  const architectures = childProcess.execFileSync('lipo', ['-archs', helper], {
    encoding: 'utf8',
  }).trim().split(/\s+/).sort();
  assert.deepStrictEqual(architectures, ['arm64', 'x86_64']);
  assert.doesNotMatch(serviceSource, /python3|\.py(?:['"]|\b)/);
  assert.match(serviceSource, /native',\s*'author-copy-helper'/);
});

test('creates a working copy with PATH empty and no external interpreter lookup', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const previousPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const result = service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent,
        copyName: '无解释器副本',
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(
        JSON.parse(fs.readFileSync(
          path.join(destinationParent, '无解释器副本', service.COPY_MANIFEST),
          'utf8'
        )).schema,
        service.COPY_SCHEMA
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  })
);

test('native helper rejects embedded NUL and trailing request bytes before mutation', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const targetParent = path.join(scratch, 'target');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(targetParent);
    const sourceFd = fs.openSync(sourceParent, fs.constants.O_RDONLY);
    const targetFd = fs.openSync(targetParent, fs.constants.O_RDONLY);
    try {
      const result = childProcess.spawnSync(
        path.join(__dirname, '..', 'src', 'main', 'native', 'author-copy-helper'),
        [],
        {
          input: Buffer.from('{"mode":"reserve"}\0trailing', 'utf8'),
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe', sourceFd, targetFd],
        }
      );
      assert.notStrictEqual(result.status, 0);
      assert.deepStrictEqual(fs.readdirSync(sourceParent), []);
      assert.deepStrictEqual(fs.readdirSync(targetParent), []);
    } finally {
      fs.closeSync(sourceFd);
      fs.closeSync(targetFd);
    }
  })
);

test('native helper rejects reserve without a recovery receipt before mutation', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const targetParent = path.join(scratch, 'target');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(targetParent);
    const sourceFd = fs.openSync(sourceParent, fs.constants.O_RDONLY);
    const targetFd = fs.openSync(targetParent, fs.constants.O_RDONLY);
    try {
      const result = childProcess.spawnSync(
        path.join(__dirname, '..', 'src', 'main', 'native', 'author-copy-helper'),
        [],
        {
          input: '{"mode":"reserve"}',
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe', sourceFd, targetFd],
        }
      );
      assert.notStrictEqual(result.status, 0);
      assert.deepStrictEqual(fs.readdirSync(sourceParent), []);
      assert.deepStrictEqual(fs.readdirSync(targetParent), []);
    } finally {
      fs.closeSync(sourceFd);
      fs.closeSync(targetFd);
    }
  })
);

test('native helper rejects a read-only recovery receipt before mutation', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const targetParent = path.join(scratch, 'target');
    const receiptPath = path.join(scratch, 'receipt');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(targetParent);
    fs.writeFileSync(receiptPath, '');
    fs.chmodSync(receiptPath, 0o600);
    const sourceFd = fs.openSync(sourceParent, fs.constants.O_RDONLY);
    const targetFd = fs.openSync(targetParent, fs.constants.O_RDONLY);
    const receiptFd = fs.openSync(receiptPath, fs.constants.O_RDONLY);
    try {
      const result = childProcess.spawnSync(
        path.join(__dirname, '..', 'src', 'main', 'native', 'author-copy-helper'),
        [],
        {
          input: '{"mode":"reserve"}',
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe', sourceFd, targetFd, receiptFd],
        }
      );
      assert.notStrictEqual(result.status, 0);
      assert.deepStrictEqual(fs.readdirSync(sourceParent), []);
      assert.deepStrictEqual(fs.readdirSync(targetParent), []);
    } finally {
      fs.closeSync(receiptFd);
      fs.closeSync(sourceFd);
      fs.closeSync(targetFd);
    }
  })
);

test('test-only native helper rejects a 0755 pre-open replacement without changing either directory', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const targetParent = path.join(scratch, 'target');
    const receiptPath = path.join(scratch, 'receipt');
    const testHelper = path.join(scratch, 'author-copy-helper-preownership-test');
    const productionTestHelper = path.join(scratch, 'author-copy-helper-production-test');
    const sourceFile = path.join(__dirname, '..', 'native', 'author-copy-helper.c');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(targetParent);
    fs.writeFileSync(receiptPath, '');
    fs.chmodSync(receiptPath, 0o600);
    childProcess.execFileSync('xcrun', [
      '--sdk', 'macosx', 'clang',
      '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
      '-mmacosx-version-min=11.0',
      '-DWRITCRAFT_TEST_RESERVE_PREOWNERSHIP',
      sourceFile,
      '-o', testHelper,
    ], { stdio: 'inherit' });
    childProcess.execFileSync('xcrun', [
      '--sdk', 'macosx', 'clang',
      '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
      '-mmacosx-version-min=11.0',
      sourceFile,
      '-o', productionTestHelper,
    ], { stdio: 'inherit' });
    const productionStrings = childProcess.execFileSync('strings', [productionTestHelper], {
      encoding: 'utf8',
    });
    assert(!productionStrings.includes('WRITCRAFT_TEST_RESERVE_PREOWNERSHIP'));
    assert(!productionStrings.includes('.original-'));
    const sourceFd = fs.openSync(sourceParent, fs.constants.O_RDONLY);
    const targetFd = fs.openSync(targetParent, fs.constants.O_RDONLY);
    const receiptFd = fs.openSync(receiptPath, fs.constants.O_RDWR);
    try {
      const result = childProcess.spawnSync(testHelper, [], {
        input: '{"mode":"reserve"}',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe', sourceFd, targetFd, receiptFd],
      });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(fs.readFileSync(receiptPath, 'utf8'), '');
      const entries = fs.readdirSync(sourceParent).sort();
      assert.strictEqual(entries.length, 2);
      const originalName = entries.find(name => name.startsWith('.original-'));
      const replacementName = entries.find(name => name.startsWith('.writcraft-author-copy-'));
      assert(originalName);
      assert(replacementName);
      const original = fs.statSync(path.join(sourceParent, originalName));
      const replacement = fs.statSync(path.join(sourceParent, replacementName));
      assert(original.isDirectory());
      assert(replacement.isDirectory());
      assert.strictEqual(original.mode & 0o777, 0o700);
      assert.strictEqual(replacement.mode & 0o777, 0o755);
      assert.deepStrictEqual(fs.readdirSync(path.join(sourceParent, originalName)), []);
      assert.deepStrictEqual(fs.readdirSync(path.join(sourceParent, replacementName)), []);
    } finally {
      fs.closeSync(receiptFd);
      fs.closeSync(sourceFd);
      fs.closeSync(targetFd);
    }

    const inheritedGroup = process.getgroups().find(group => group !== process.getegid());
    if (inheritedGroup !== undefined) {
      const groupParent = path.join(scratch, 'group-parent');
      const groupReceipt = path.join(scratch, 'group-receipt');
      fs.mkdirSync(groupParent);
      fs.chownSync(groupParent, process.getuid(), inheritedGroup);
      fs.chmodSync(groupParent, 0o2700);
      fs.writeFileSync(groupReceipt, '');
      fs.chmodSync(groupReceipt, 0o600);
      const groupParentFd = fs.openSync(groupParent, fs.constants.O_RDONLY);
      const groupReceiptFd = fs.openSync(groupReceipt, fs.constants.O_RDWR);
      try {
        const result = childProcess.spawnSync(productionTestHelper, [], {
          input: '{"mode":"reserve"}',
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe', groupParentFd, groupParentFd, groupReceiptFd],
        });
        assert.strictEqual(result.status, 0);
        const report = JSON.parse(result.stdout);
        const reserved = fs.statSync(path.join(groupParent, report.name));
        assert.strictEqual(reserved.gid, inheritedGroup);
        assert.strictEqual(reserved.mode & 0o777, 0o700);
      } finally {
        fs.closeSync(groupReceiptFd);
        fs.closeSync(groupParentFd);
      }
    }
  })
);

test('reports every unmet author-project requirement without returning paths or content', () =>
  withScratch(scratch => {
    const descriptor = projectService.createProjectAt(scratch, '不足项目');
    projectService.createMarkdownFile(descriptor.rootPath, 'chapters/only.md', '# 只有一章\n\n短文。');
    const report = service.inspectProject(descriptor.rootPath);
    assert.strictEqual(report.eligible, false);
    assert.deepStrictEqual(report.errors, [
      'CHAPTER_COUNT_INSUFFICIENT',
      'MANUSCRIPT_TOO_SHORT',
      'SOURCE_MATERIAL_REQUIRED',
    ]);
    const serialized = JSON.stringify(report);
    assert(!serialized.includes(descriptor.rootPath));
    for (const forbidden of ['rootPath', 'path', 'content', 'prompt', 'fileNames']) {
      assert(!flattenedKeys(report).includes(forbidden));
    }
  })
);

test('requires a valid root edit.md instead of accepting a chapter-only folder', () =>
  withScratch(scratch => {
    const root = path.join(scratch, 'no-edit');
    fs.mkdirSync(path.join(root, 'chapters'), { recursive: true });
    fs.mkdirSync(path.join(root, 'references'), { recursive: true });
    fs.writeFileSync(path.join(root, 'chapters', '01.md'), '正文'.repeat(1100));
    for (let index = 2; index <= 5; index += 1) {
      fs.writeFileSync(path.join(root, 'chapters', `0${index}.md`), '# 章节');
    }
    fs.writeFileSync(path.join(root, 'references', 'source.txt'), 'source');
    const report = service.inspectProject(root);
    assert.strictEqual(report.eligible, false);
    assert(report.errors.includes('EDIT_MD_REQUIRED'));
  })
);

test('rejects invalid edit.md front matter as an explicit preflight error', () =>
  withScratch(scratch => {
    const project = buildEligible(scratch);
    fs.writeFileSync(path.join(project.rootPath, 'edit.md'), '---\nschema: writcraft.edit/v1\n# unclosed');
    const report = service.inspectProject(project.rootPath);
    assert.strictEqual(report.eligible, false);
    assert(report.errors.includes('EDIT_MD_INVALID'));
  })
);

test('fails closed on symlinks and hard-linked project files', () =>
  withScratch(scratch => {
    const symlinkProject = buildEligible(scratch, '符号链接');
    fs.symlinkSync(
      path.join(symlinkProject.rootPath, 'chapters', '01-arrival.md'),
      path.join(symlinkProject.rootPath, 'chapters', 'linked.md')
    );
    assert.throws(
      () => service.inspectProject(symlinkProject.rootPath),
      error => error.code === 'SYMLINK_NOT_ALLOWED'
    );

    const hardlinkProject = buildEligible(scratch, '硬链接');
    fs.linkSync(
      path.join(hardlinkProject.rootPath, 'chapters', '01-arrival.md'),
      path.join(hardlinkProject.rootPath, 'chapters', 'linked.md')
    );
    assert.throws(
      () => service.inspectProject(hardlinkProject.rootPath),
      error => error.code === 'HARD_LINK_NOT_ALLOWED'
    );
  })
);

test('enforces file, project and depth bounds before a copy can be prepared', () =>
  withScratch(scratch => {
    const project = buildEligible(scratch);
    assert.throws(
      () => service.inspectProject(project.rootPath, { maxFiles: 2 }),
      error => error.code === 'TREE_TOO_LARGE'
    );
    assert.throws(
      () => service.inspectProject(project.rootPath, { maxFileBytes: 10 }),
      error => error.code === 'FILE_TOO_LARGE'
    );
    assert.throws(
      () => service.inspectProject(project.rootPath, { maxTotalBytes: 100 }),
      error => error.code === 'PROJECT_TOO_LARGE'
    );
    fs.mkdirSync(path.join(project.rootPath, 'references', 'nested'));
    fs.writeFileSync(path.join(project.rootPath, 'references', 'nested', 'source.txt'), 'source');
    assert.throws(
      () => service.inspectProject(project.rootPath, { maxDepth: 1 }),
      error => error.code === 'TREE_TOO_DEEP'
    );
  })
);

test('creates an isolated exact working copy while leaving the source snapshot unchanged', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const before = service.scanProjectTree(project.rootPath);
    const result = service.createWorkingCopy({
      rootPath: project.rootPath,
      destinationParent,
      copyName: '作者验收副本',
    }, {
      now: () => new Date('2026-07-27T03:00:00.000Z'),
      randomHex: () => 'a'.repeat(24),
    });
    const after = service.scanProjectTree(project.rootPath);
    const copyRoot = path.join(destinationParent, '作者验收副本');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.sourceUnchanged, true);
    assert.strictEqual(after.snapshotDigest, before.snapshotDigest);
    assert.strictEqual(result.sourceSnapshotDigest, before.snapshotDigest);
    assert.strictEqual(
      fs.readFileSync(path.join(copyRoot, 'edit.md'), 'utf8'),
      fs.readFileSync(path.join(project.rootPath, 'edit.md'), 'utf8')
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(copyRoot, service.COPY_MANIFEST), 'utf8'));
    assert.deepStrictEqual(Object.keys(manifest), [
      'schema', 'createdAt', 'sourceSnapshotDigest',
      'sourceFileCount', 'sourceBytes', 'sourceUnchanged',
    ]);
    assert.strictEqual(manifest.schema, service.COPY_SCHEMA);
    assert.strictEqual(manifest.sourceSnapshotDigest, before.snapshotDigest);
    assert(!JSON.stringify(manifest).includes(project.rootPath));
  })
);

test('removes the private stage and publishes nothing when the source changes during copying', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const target = path.join(project.rootPath, 'chapters', '01-arrival.md');
    assert.throws(
      () => service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent,
        copyName: '变化副本',
      }, {
        randomHex: () => 'b'.repeat(24),
        beforeSourceRecheck: () => fs.appendFileSync(target, '\n源文件发生变化\n'),
      }),
      error => error.code === 'SOURCE_CHANGED'
    );
    assert.strictEqual(fs.existsSync(path.join(destinationParent, '变化副本')), false);
    assert.deepStrictEqual(fs.readdirSync(destinationParent), []);
  })
);

test('refuses a destination inside the manuscript and an occupied final name', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    assert.throws(
      () => service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent: project.rootPath,
        copyName: '内部副本',
      }),
      error => error.code === 'COPY_DESTINATION_INSIDE_SOURCE'
    );
    fs.mkdirSync(path.join(destinationParent, '已存在'));
    assert.throws(
      () => service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent,
        copyName: '已存在',
      }),
      error => error.code === 'COPY_ALREADY_EXISTS'
    );
  })
);

test('CLI parsing and public reports keep paths and manuscript fields out of evidence', () =>
  withScratch(scratch => {
    const project = buildEligible(scratch);
    const parsed = cli.parseArguments(['--project', project.rootPath]);
    assert.strictEqual(parsed.project, project.rootPath);
    assert.throws(
      () => cli.parseArguments(['--project', project.rootPath, '--copy-to', scratch]),
      error => error.code === 'COPY_ARGUMENTS_INCOMPLETE'
    );
    const publicReport = cli.publicReport(service.inspectProject(project.rootPath));
    const keys = flattenedKeys(publicReport);
    for (const forbidden of ['rootPath', 'path', 'content', 'prompt', 'apiKey']) {
      assert(!keys.includes(forbidden));
    }
  })
);

test('real CLI creates the eligible working copy and emits metadata-only JSON', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const run = childProcess.spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'prepare-author-acceptance.js'),
      '--project', project.rootPath,
      '--copy-to', destinationParent,
      '--name', 'CLI验收副本',
    ], { encoding: 'utf8', timeout: 10_000 });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.stderr, '');
    const report = JSON.parse(run.stdout);
    assert.strictEqual(report.schema, service.COPY_SCHEMA);
    assert.strictEqual(report.copyCreated, true);
    assert.strictEqual(report.preflight.eligible, true);
    assert.strictEqual(fs.existsSync(path.join(destinationParent, 'CLI验收副本', 'edit.md')), true);
    assert(!run.stdout.includes(project.rootPath));
    assert(!run.stdout.includes(destinationParent));
    for (const forbidden of ['rootPath', 'path', 'content', 'prompt', 'apiKey']) {
      assert(!flattenedKeys(report).includes(forbidden));
    }
  })
);

test('derives eligibility and copied bytes from one initial authoritative scan', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const originalOpen = fs.openSync;
    const originalInspect = projectService.inspectEditFrontMatter;
    let sourceEditReads = 0;
    let readsAtInspection = null;
    fs.openSync = function trackedOpen(target, flags, ...rest) {
      if (isReadOnlyOpen(flags) && path.basename(String(target)) === 'edit.md') {
        if (process.cwd() === project.rootPath) sourceEditReads += 1;
      }
      return originalOpen.call(fs, target, flags, ...rest);
    };
    projectService.inspectEditFrontMatter = function trackedInspection(...args) {
      readsAtInspection = sourceEditReads;
      return originalInspect.apply(projectService, args);
    };
    try {
      const result = service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent,
        copyName: '单一扫描副本',
      });
      assert.strictEqual(result.preflight.snapshotDigest, result.sourceSnapshotDigest);
      assert.strictEqual(readsAtInspection, 1, 'eligibility must derive from the initial scan');
      assert.strictEqual(sourceEditReads, 3, 'initial, precommit and postcommit scans only');
    } finally {
      fs.openSync = originalOpen;
      projectService.inspectEditFrontMatter = originalInspect;
    }
  })
);

test('treats the final source recheck as the last action before exclusive publication', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const target = path.join(project.rootPath, 'chapters', '01-arrival.md');
    assert.throws(
      () => service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent,
        copyName: '最终复核副本',
      }, {
        beforePublish: () => fs.appendFileSync(target, '\n最终复核后变化\n'),
      }),
      error => error.code === 'SOURCE_CHANGED'
    );
    assert.strictEqual(fs.existsSync(path.join(destinationParent, '最终复核副本')), false);
  })
);

test('never reads an outside file when the selected source ancestor is replaced', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const outsideParent = path.join(scratch, 'outside');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(outsideParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent, '被替换项目');
    const outside = buildEligible(outsideParent, '外部私稿');
    const outsideEdit = fs.statSync(path.join(outside.rootPath, 'edit.md'));
    const movedRoot = `${project.rootPath}.moved`;
    const originalOpen = fs.openSync;
    const originalRead = fs.readSync;
    let replacementDone = false;
    let outsideBytesRead = 0;
    fs.openSync = function replacingOpen(target, flags, ...rest) {
      if (!replacementDone && isReadOnlyOpen(flags) &&
          path.basename(String(target)) === 'edit.md') {
        replacementDone = true;
        fs.renameSync(project.rootPath, movedRoot);
        fs.symlinkSync(outside.rootPath, project.rootPath);
      }
      return originalOpen.call(fs, target, flags, ...rest);
    };
    fs.readSync = function trackedRead(fd, ...rest) {
      const stat = fs.fstatSync(fd);
      if (stat.dev === outsideEdit.dev && stat.ino === outsideEdit.ino) outsideBytesRead += 1;
      return originalRead.call(fs, fd, ...rest);
    };
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '祖先替换副本',
        }),
        error => [
          'SOURCE_CHANGED',
          'SOURCE_PATH_CHANGED',
          'PATH_IDENTITY_CHANGED',
          'PATH_TRAVERSAL',
        ].includes(error.code)
      );
      assert.strictEqual(outsideBytesRead, 0);
    } finally {
      fs.openSync = originalOpen;
      fs.readSync = originalRead;
    }
  })
);

test('never redirects copy bytes when the owned destination root is replaced', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const before = snapshotProject(project.rootPath);
    const originalOpen = fs.openSync;
    let replacementDone = false;
    fs.openSync = function replacingOpen(target, flags, ...rest) {
      const text = String(target);
      if (!replacementDone && !isReadOnlyOpen(flags) &&
          path.basename(text) === path.basename(service.COPY_MANIFEST)) {
        replacementDone = true;
        const cwd = process.cwd();
        const stageMatch = text.match(/^(.*\.stage)(?:\/|$)/);
        const ownedRoot = stageMatch ? stageMatch[1] : path.dirname(cwd);
        const moved = `${ownedRoot}.moved`;
        fs.renameSync(ownedRoot, moved);
        fs.symlinkSync(project.rootPath, ownedRoot);
      }
      return originalOpen.call(fs, target, flags, ...rest);
    };
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '目标替换副本',
        }),
        error => [
          'COPY_TARGET_CHANGED',
          'PATH_IDENTITY_CHANGED',
          'COPY_CLEANUP_INCOMPLETE',
        ].includes(error.code)
      );
      const after = snapshotProject(project.rootPath);
      assert.strictEqual(after.digest, before.digest);
      assert.strictEqual(
        fs.existsSync(path.join(project.rootPath, service.COPY_MANIFEST)),
        false
      );
    } finally {
      fs.openSync = originalOpen;
    }
  })
);

test('reserves the final name exclusively and never replaces a concurrent directory', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const finalTarget = path.join(destinationParent, '并发占用副本');
    let occupiedIdentity;
    assert.throws(
      () => service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent,
        copyName: '并发占用副本',
      }, {
        beforeDestinationReserve: () => {
          fs.mkdirSync(finalTarget);
          occupiedIdentity = fs.statSync(finalTarget);
        },
      }),
      error => error.code === 'COPY_ALREADY_EXISTS'
    );
    const current = fs.statSync(finalTarget);
    assert.strictEqual(current.dev, occupiedIdentity.dev);
    assert.strictEqual(current.ino, occupiedIdentity.ino);
  })
);

test('never follows a replacement of the selected destination parent', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    const outsideParent = path.join(scratch, 'outside');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    fs.mkdirSync(outsideParent);
    const project = buildEligible(sourceParent);
    const before = snapshotProject(project.rootPath);
    assert.throws(
      () => service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent,
        copyName: '父目录替换副本',
      }, {
        beforeDestinationReserve: () => {
          fs.renameSync(destinationParent, `${destinationParent}.moved`);
          fs.symlinkSync(outsideParent, destinationParent);
        },
      }),
      error => error.code === 'COPY_TARGET_CHANGED'
    );
    assert.deepStrictEqual(fs.readdirSync(outsideParent), []);
    assert.strictEqual(snapshotProject(project.rootPath).digest, before.digest);
  })
);

test('keeps the readiness manifest private until the final source recheck publishes it', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    let observedInvalid = false;
    const result = service.createWorkingCopy({
      rootPath: project.rootPath,
      destinationParent,
      copyName: '就绪标记副本',
    }, {
      beforePublish({ finalTarget }) {
        const prepared = fs.readFileSync(path.join(finalTarget, service.COPY_MANIFEST), 'utf8');
        assert.throws(() => JSON.parse(prepared));
        observedInvalid = true;
      },
    });
    assert.strictEqual(observedInvalid, true);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(
        path.join(destinationParent, '就绪标记副本', service.COPY_MANIFEST),
        'utf8'
      )).schema,
      service.COPY_SCHEMA
    );
  })
);

test('cleanup removes only owned identities and preserves a foreign arrival', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    let candidateTarget;
    let foreign;
    assert.throws(
      () => service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent,
        copyName: '精确清理副本',
      }, {
        beforePublish({ finalTarget }) {
          candidateTarget = finalTarget;
          foreign = path.join(finalTarget, 'foreign.txt');
          fs.writeFileSync(foreign, 'FOREIGN');
          fs.appendFileSync(
            path.join(project.rootPath, 'chapters', '01-arrival.md'),
            '\n触发回滚\n'
          );
        },
      }),
      error => error.code === 'COPY_CLEANUP_INCOMPLETE' &&
        ['SOURCE_CHANGED', 'COPY_VERIFY_FAILED'].includes(error.causeCode)
    );
    assert.strictEqual(fs.readFileSync(foreign, 'utf8'), 'FOREIGN');
    assert.deepStrictEqual(fs.readdirSync(candidateTarget), ['foreign.txt']);
  })
);

test('cleanup aborts all deletion when an owned child directory is replaced', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    const outside = path.join(scratch, 'outside');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'KEEP.txt'), 'KEEP');
    const project = buildEligible(sourceParent);
    let candidateTarget;
    const originalLstat = fs.lstatSync;
    let cleanupPhase = false;
    let replaced = false;
    fs.lstatSync = function replaceDuringCleanup(target, ...rest) {
      const stat = originalLstat.call(fs, target, ...rest);
      if (cleanupPhase && !replaced && String(target) === 'chapters' &&
          candidateTarget &&
          path.basename(process.cwd()) === path.basename(candidateTarget)) {
        replaced = true;
        fs.renameSync('chapters', 'chapters.moved');
        fs.symlinkSync(outside, 'chapters');
      }
      return stat;
    };
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '清理替换副本',
        }, {
          beforePublish({ finalTarget }) {
            candidateTarget = finalTarget;
            fs.appendFileSync(
              path.join(project.rootPath, 'chapters', '01-arrival.md'),
              '\n触发目录清理\n'
            );
            cleanupPhase = true;
          },
        }),
        error => error.code === 'COPY_CLEANUP_INCOMPLETE'
      );
      assert.strictEqual(replaced, true);
      assert.strictEqual(fs.readFileSync(path.join(outside, 'KEEP.txt'), 'utf8'), 'KEEP');
    } finally {
      fs.lstatSync = originalLstat;
    }
  })
);

test('recovers committed truth when the readiness commit succeeds and then throws', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const originalFsync = fs.fsyncSync;
    let injected = false;
    fs.fsyncSync = function committedThenThrew(fd) {
      const first = Buffer.alloc(1);
      let ready = false;
      try {
        ready = fs.readSync(fd, first, 0, 1, 0) === 1 && first[0] === 0x7b;
      } catch (_) {}
      const result = originalFsync.call(fs, fd);
      if (ready && !injected) {
        injected = true;
        throw Object.assign(new Error('committed then threw'), { code: 'EIO' });
      }
      return result;
    };
    try {
      const result = service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent,
        copyName: '提交恢复副本',
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.committedRecovered, true);
      const manifest = JSON.parse(fs.readFileSync(
        path.join(destinationParent, '提交恢复副本', service.COPY_MANIFEST),
        'utf8'
      ));
      assert.strictEqual(manifest.sourceSnapshotDigest, result.sourceSnapshotDigest);
      assert.strictEqual(injected, true);
    } finally {
      fs.fsyncSync = originalFsync;
    }
  })
);

test('reports committed truth if the source changes in the final commit syscall window', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const sourceFile = path.join(project.rootPath, 'chapters', '01-arrival.md');
    const originalSpawn = childProcess.spawnSync;
    let injected = false;
    childProcess.spawnSync = function changeAtPublish(command, args, options) {
      const request = JSON.parse(String(options?.input || '{}'));
      if (!injected &&
          isAuthorCopyHelper(command) &&
          request.mode === 'publish') {
        injected = true;
        fs.appendFileSync(sourceFile, '\n提交瞬间变化\n');
      }
      return originalSpawn.call(childProcess, command, args, options);
    };
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '提交窗口副本',
        }),
        error => error.code === 'COPY_COMMITTED_SOURCE_CHANGED' &&
          error.committed === true
      );
      assert.strictEqual(injected, true);
      const manifest = JSON.parse(fs.readFileSync(
        path.join(destinationParent, '提交窗口副本', service.COPY_MANIFEST),
        'utf8'
      ));
      assert.strictEqual(manifest.schema, service.COPY_SCHEMA);
    } finally {
      childProcess.spawnSync = originalSpawn;
    }
  })
);

test('rejects and preserves a copied file rewritten in place before readiness', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    let candidateTarget;
    let copiedChapter;
    let foreignBytes;
    assert.throws(
      () => service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent,
        copyName: '内容改写副本',
      }, {
        beforePublish({ finalTarget }) {
          candidateTarget = finalTarget;
          copiedChapter = path.join(finalTarget, 'chapters', '01-arrival.md');
          const original = fs.readFileSync(copiedChapter);
          foreignBytes = Buffer.alloc(original.length, 0x58);
          fs.writeFileSync(copiedChapter, foreignBytes);
        },
      }),
      error => error.code === 'COPY_CLEANUP_INCOMPLETE' &&
        error.causeCode === 'COPY_VERIFY_FAILED'
    );
    const preserved = [];
    function findPreserved(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) findPreserved(target);
        else if (fs.readFileSync(target).equals(foreignBytes)) preserved.push(target);
      }
    }
    findPreserved(candidateTarget);
    assert.strictEqual(preserved.length, 1);
  })
);

test('never commits through a manifest fd whose public path was replaced', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    let manifestPath;
    assert.throws(
      () => service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent,
        copyName: '清单替换副本',
      }, {
        beforePublish({ finalTarget }) {
          manifestPath = path.join(finalTarget, service.COPY_MANIFEST);
          fs.renameSync(manifestPath, `${manifestPath}.owned`);
          fs.writeFileSync(manifestPath, 'FOREIGN');
        },
      }),
      error => error.code === 'COPY_CLEANUP_INCOMPLETE' &&
        error.causeCode === 'COPY_VERIFY_FAILED'
    );
    const preserved = [];
    function findPreserved(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) findPreserved(target);
        else preserved.push(fs.readFileSync(target, 'utf8'));
      }
    }
    findPreserved(path.dirname(path.dirname(manifestPath)));
    assert(preserved.includes('FOREIGN'));
    assert(preserved.some(value => value.startsWith(' ')));
  })
);

test('quarantines an owned cleanup entry before a foreign stable-path arrival', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    let candidateTarget;
    const originalUnlink = fs.unlinkSync;
    let injected = false;
    fs.unlinkSync = function foreignAtDeleteBoundary(target) {
      const name = path.basename(String(target));
      if (!injected && name.startsWith('.writcraft-author-cleanup-')) {
        injected = true;
        fs.writeFileSync(path.join(process.cwd(), 'foreign-at-stable-name.txt'), 'FOREIGN');
      }
      return originalUnlink.call(fs, target);
    };
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '删除边界副本',
        }, {
          beforePublish({ finalTarget }) {
            candidateTarget = finalTarget;
            fs.appendFileSync(
              path.join(project.rootPath, 'chapters', '01-arrival.md'),
              '\n触发精确清理\n'
            );
          },
        }),
        error => error.code === 'COPY_CLEANUP_INCOMPLETE'
      );
      assert.strictEqual(injected, true);
      const preserved = [];
      function findForeign(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory()) findForeign(target);
          else if (entry.name === 'foreign-at-stable-name.txt') preserved.push(target);
        }
      }
      findForeign(candidateTarget);
      assert.strictEqual(preserved.length, 1);
      assert.strictEqual(fs.readFileSync(preserved[0], 'utf8'), 'FOREIGN');
    } finally {
      fs.unlinkSync = originalUnlink;
    }
  })
);

test('reports committed truth when final parent fsync succeeds and then throws', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const finalTarget = path.join(destinationParent, '预留持久化副本');
    const originalFsync = fs.fsyncSync;
    let injected = false;
    fs.fsyncSync = function reservationFsyncThenThrow(fd) {
      const result = originalFsync.call(fs, fd);
      if (!injected && fs.existsSync(finalTarget)) {
        injected = true;
        throw Object.assign(new Error('reservation fsync committed'), { code: 'EIO' });
      }
      return result;
    };
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '预留持久化副本',
        }),
        error => error.code === 'COPY_COMMITTED_FSYNC_FAILED' &&
          error.committed === true &&
          error.causeCode === 'EIO'
      );
      assert.strictEqual(injected, true);
      assert.strictEqual(
        JSON.parse(fs.readFileSync(path.join(finalTarget, service.COPY_MANIFEST), 'utf8')).schema,
        service.COPY_SCHEMA
      );
    } finally {
      fs.fsyncSync = originalFsync;
    }
  })
);

test('recovers an exclusive publish that committed before the helper reported failure', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const finalTarget = path.join(destinationParent, '不确定预留副本');
    const originalSpawn = childProcess.spawnSync;
    let injected = false;
    childProcess.spawnSync = function publishThenReportFailure(command, args, options) {
      const result = originalSpawn.call(childProcess, command, args, options);
      const request = JSON.parse(String(options?.input || '{}'));
      if (!injected &&
          isAuthorCopyHelper(command) &&
          request.mode === 'publish') {
        injected = true;
        return {
          ...result,
          status: 1,
          stdout: '{"ok":false,"errno":5}',
        };
      }
      return result;
    };
    try {
      const result = service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent,
        copyName: '不确定预留副本',
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.committedRecovered, true);
      assert.strictEqual(injected, true);
      assert.strictEqual(
        JSON.parse(fs.readFileSync(path.join(finalTarget, service.COPY_MANIFEST), 'utf8')).schema,
        service.COPY_SCHEMA
      );
    } finally {
      childProcess.spawnSync = originalSpawn;
    }
  })
);

test('reports committed-unknown if publish succeeds but both helper reports are lost', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const finalTarget = path.join(destinationParent, '双报告丢失副本');
    const originalSpawn = childProcess.spawnSync;
    let publishCommitted = false;
    let inspectSuppressed = false;
    childProcess.spawnSync = function losePublishReports(command, args, options) {
      const request = JSON.parse(String(options?.input || '{}'));
      if (request.mode === 'publish') {
        const result = originalSpawn.call(childProcess, command, args, options);
        publishCommitted = result.status === 0;
        return { ...result, status: 1, stdout: '' };
      }
      if (publishCommitted && request.mode === 'inspect') {
        inspectSuppressed = true;
        return { status: 1, signal: null, stdout: '', stderr: '' };
      }
      return originalSpawn.call(childProcess, command, args, options);
    };
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '双报告丢失副本',
        }),
        error => error.code === 'COPY_PUBLISH_UNCERTAIN' &&
          error.committed === true
      );
      assert.strictEqual(publishCommitted, true);
      assert.strictEqual(inspectSuppressed, true);
      assert.strictEqual(
        JSON.parse(fs.readFileSync(
          path.join(finalTarget, service.COPY_MANIFEST),
          'utf8'
        )).schema,
        service.COPY_SCHEMA
      );
      assert.strictEqual(
        fs.existsSync(path.join(finalTarget, 'chapters', '01-arrival.md')),
        true
      );
    } finally {
      childProcess.spawnSync = originalSpawn;
    }
  })
);

test('cleans a proven private stage after a malformed non-committing publish report', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const originalSpawn = childProcess.spawnSync;
    let candidateTarget;
    childProcess.spawnSync = function suppressPublish(command, args, options) {
      const request = JSON.parse(String(options?.input || '{}'));
      if (request.mode === 'publish') {
        return { status: 1, signal: null, stdout: '{"ok":false}', stderr: '' };
      }
      return originalSpawn.call(childProcess, command, args, options);
    };
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '未提交可证明副本',
        }, {
          beforePublish({ finalTarget }) {
            candidateTarget = finalTarget;
          },
        }),
        error => error.code === 'COPY_ATOMIC_PUBLISH_FAILED' &&
          error.committed !== true
      );
      assert.strictEqual(fs.existsSync(candidateTarget), false);
      assert.strictEqual(
        fs.existsSync(path.join(destinationParent, '未提交可证明副本')),
        false
      );
    } finally {
      childProcess.spawnSync = originalSpawn;
    }
  })
);

test('preserves a private stage when both non-commit helper reports are unavailable', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const originalSpawn = childProcess.spawnSync;
    let candidateTarget;
    childProcess.spawnSync = function suppressPublishAndInspect(command, args, options) {
      const request = JSON.parse(String(options?.input || '{}'));
      if (request.mode === 'publish' || request.mode === 'inspect') {
        return { status: 1, signal: null, stdout: '', stderr: '' };
      }
      return originalSpawn.call(childProcess, command, args, options);
    };
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '未提交未知副本',
        }, {
          beforePublish({ finalTarget }) {
            candidateTarget = finalTarget;
          },
        }),
        error => error.code === 'COPY_PUBLISH_UNCERTAIN' &&
          error.committed === true
      );
      assert.strictEqual(
        JSON.parse(fs.readFileSync(
          path.join(candidateTarget, service.COPY_MANIFEST),
          'utf8'
        )).schema,
        service.COPY_SCHEMA
      );
      assert.strictEqual(
        fs.existsSync(path.join(destinationParent, '未提交未知副本')),
        false
      );
    } finally {
      childProcess.spawnSync = originalSpawn;
    }
  })
);

test('recovers a completed private reservation when the helper stdout and status are lost', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const finalTarget = path.join(destinationParent, '预留回执恢复副本');
    const originalSpawn = childProcess.spawnSync;
    let reservedStage = null;
    childProcess.spawnSync = function loseReserveReceipt(command, args, options) {
      const result = originalSpawn.call(childProcess, command, args, options);
      const request = JSON.parse(String(options?.input || '{}'));
      if (isAuthorCopyHelper(command) && request.mode === 'reserve' && result.status === 0 && !reservedStage) {
        const report = JSON.parse(String(result.stdout));
        reservedStage = path.join(destinationParent, report.name);
        return { ...result, status: 1, stdout: '', stderr: '' };
      }
      return result;
    };
    try {
      const result = service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent,
        copyName: '预留回执恢复副本',
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(Object.hasOwn(result, 'reservationRecovered'), false);
      assert.strictEqual(fs.existsSync(reservedStage), false);
      assert.strictEqual(
        JSON.parse(fs.readFileSync(path.join(finalTarget, service.COPY_MANIFEST), 'utf8')).schema,
        service.COPY_SCHEMA
      );
    } finally {
      childProcess.spawnSync = originalSpawn;
    }
  })
);

test('fails closed and preserves the stage when reserve stdout and its receipt are both unavailable', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const originalSpawn = childProcess.spawnSync;
    let reservedStage = null;
    childProcess.spawnSync = function loseReserveEvidence(command, args, options) {
      const result = originalSpawn.call(childProcess, command, args, options);
      const request = JSON.parse(String(options?.input || '{}'));
      if (isAuthorCopyHelper(command) && request.mode === 'reserve' && result.status === 0 && !reservedStage) {
        const report = JSON.parse(String(result.stdout));
        reservedStage = path.join(destinationParent, report.name);
        fs.ftruncateSync(options.stdio[5], 0);
        return { ...result, status: 1, stdout: '', stderr: '' };
      }
      return result;
    };
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '预留证据丢失副本',
        }),
        error => error.code === 'COPY_RESERVATION_UNCERTAIN' && error.committed !== true
      );
      const stage = fs.lstatSync(reservedStage, { bigint: true });
      assert(stage.isDirectory());
      assert.strictEqual(Number(stage.mode & 0o777n), 0o700);
      assert.deepStrictEqual(fs.readdirSync(reservedStage), []);
      assert.strictEqual(fs.existsSync(path.join(destinationParent, '预留证据丢失副本')), false);
    } finally {
      childProcess.spawnSync = originalSpawn;
    }
  })
);

test('never adopts or deletes a replacement after receipt-based reserve recovery', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const originalSpawn = childProcess.spawnSync;
    let reservedStage = null;
    let originalStage = null;
    childProcess.spawnSync = function replaceRecoveredReservation(command, args, options) {
      const result = originalSpawn.call(childProcess, command, args, options);
      const request = JSON.parse(String(options?.input || '{}'));
      if (isAuthorCopyHelper(command) && request.mode === 'reserve' && result.status === 0 && !reservedStage) {
        const report = JSON.parse(String(result.stdout));
        reservedStage = path.join(destinationParent, report.name);
        originalStage = `${reservedStage}-original`;
        fs.renameSync(reservedStage, originalStage);
        fs.mkdirSync(reservedStage, { mode: 0o700 });
        return { ...result, status: 1, stdout: '', stderr: '' };
      }
      return result;
    };
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '预留换壳恢复副本',
        }),
        error => error.code === 'COPY_RESERVATION_UNCERTAIN' &&
          error.reservationOwnershipUncertain === true && error.committed === false
      );
      assert.deepStrictEqual(fs.readdirSync(reservedStage), []);
      assert.deepStrictEqual(fs.readdirSync(originalStage), []);
      assert.strictEqual(fs.existsSync(path.join(destinationParent, '预留换壳恢复副本')), false);
    } finally {
      childProcess.spawnSync = originalSpawn;
    }
  })
);

test('never adopts a replacement inserted after the native stage reservation', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const originalSpawn = childProcess.spawnSync;
    let replacementPath;
    let originalPath;
    childProcess.spawnSync = function replaceReservedStage(command, args, options) {
      const result = originalSpawn.call(childProcess, command, args, options);
      const request = JSON.parse(String(options?.input || '{}'));
      if (request.mode === 'reserve' && result.status === 0 && !replacementPath) {
        const report = JSON.parse(String(result.stdout));
        replacementPath = path.join(destinationParent, report.name);
        originalPath = `${replacementPath}-original`;
        fs.renameSync(replacementPath, originalPath);
        fs.mkdirSync(replacementPath, { mode: 0o700 });
      }
      return result;
    };
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '预留换壳副本',
        }),
        error => error.code === 'COPY_RESERVATION_UNCERTAIN' &&
          error.reservationOwnershipUncertain === true &&
          error.committed === false
      );
      assert.deepStrictEqual(fs.readdirSync(replacementPath), []);
      assert.deepStrictEqual(fs.readdirSync(originalPath), []);
      assert.strictEqual(
        fs.existsSync(path.join(destinationParent, '预留换壳副本')),
        false
      );
    } finally {
      childProcess.spawnSync = originalSpawn;
    }
  })
);

test('publishes through the bound parent fd when its public path is replaced', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    const movedParent = path.join(scratch, 'copies-original');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const originalSpawn = childProcess.spawnSync;
    let injected = false;
    childProcess.spawnSync = function replaceParentAtPublish(command, args, options) {
      const request = JSON.parse(String(options?.input || '{}'));
      if (!injected && request.mode === 'publish') {
        injected = true;
        fs.renameSync(destinationParent, movedParent);
        fs.mkdirSync(destinationParent);
        fs.mkdirSync(path.join(destinationParent, request.source), { mode: 0o700 });
      }
      return originalSpawn.call(childProcess, command, args, options);
    };
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '父目录绑定副本',
        }),
        error => error.code === 'COPY_COMMITTED_TARGET_CHANGED' &&
          error.committed === true
      );
      assert.strictEqual(injected, true);
      assert.strictEqual(
        fs.existsSync(path.join(destinationParent, '父目录绑定副本')),
        false
      );
      assert.deepStrictEqual(
        fs.readdirSync(destinationParent).filter(name => name === '父目录绑定副本'),
        []
      );
      assert.strictEqual(
        JSON.parse(fs.readFileSync(
          path.join(movedParent, '父目录绑定副本', service.COPY_MANIFEST),
          'utf8'
        )).schema,
        service.COPY_SCHEMA
      );
      assert.strictEqual(
        fs.existsSync(path.join(movedParent, '父目录绑定副本', 'chapters', '01-arrival.md')),
        true
      );
    } finally {
      childProcess.spawnSync = originalSpawn;
    }
  })
);

test('binds file modes and empty directories into the source snapshot and copy', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const emptyDirectory = path.join(project.rootPath, 'references', 'empty');
    fs.mkdirSync(emptyDirectory);
    const first = service.scanProjectTree(project.rootPath);
    fs.chmodSync(emptyDirectory, 0o700);
    const second = service.scanProjectTree(project.rootPath);
    assert.notStrictEqual(second.snapshotDigest, first.snapshotDigest);
    const result = service.createWorkingCopy({
      rootPath: project.rootPath,
      destinationParent,
      copyName: '空目录副本',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(
      fs.statSync(path.join(destinationParent, '空目录副本', 'references', 'empty')).isDirectory(),
      true
    );
  })
);

test('counts empty directories against the hard project entry limit', () =>
  withScratch(scratch => {
    const project = buildEligible(scratch);
    const baseline = service.scanProjectTree(project.rootPath);
    const maximumEntries =
      baseline.files.length + baseline.directories.length - 1 + 5;
    assert.strictEqual(
      service.inspectProject(project.rootPath, { maxFiles: maximumEntries }).eligible,
      true
    );
    for (let index = 0; index < 6; index += 1) {
      fs.mkdirSync(path.join(project.rootPath, 'references', `empty-${index}`));
    }
    assert.throws(
      () => service.inspectProject(project.rootPath, { maxFiles: maximumEntries }),
      error => error.code === 'TREE_TOO_LARGE'
    );
  })
);

test('rejects widened candidate directory and file permissions before publication', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    let candidateTarget;
    assert.throws(
      () => service.createWorkingCopy({
        rootPath: project.rootPath,
        destinationParent,
        copyName: '权限变化副本',
      }, {
        beforePublish({ finalTarget }) {
          candidateTarget = finalTarget;
          fs.chmodSync(finalTarget, 0o755);
          fs.chmodSync(path.join(finalTarget, 'edit.md'), 0o644);
        },
      }),
      error => error.code === 'COPY_CLEANUP_INCOMPLETE' &&
        error.causeCode === 'COPY_VERIFY_FAILED'
    );
    assert.strictEqual(fs.existsSync(path.join(destinationParent, '权限变化副本')), false);
    assert.strictEqual(fs.existsSync(candidateTarget), true);
  })
);

test('fails instead of looping when a readiness write makes zero progress', () =>
  withScratch(scratch => {
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const originalWrite = fs.writeSync;
    let injected = false;
    fs.writeSync = function zeroProgress(fd, buffer, offset, length, position) {
      if (!injected && Buffer.isBuffer(buffer) && length === 1 &&
          buffer[offset] === 0x7b && position === 0) {
        injected = true;
        return 0;
      }
      return originalWrite.call(fs, fd, buffer, offset, length, position);
    };
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '零进展副本',
        }),
        error => error.code === 'COPY_WRITE_STALLED'
      );
      assert.strictEqual(injected, true);
      assert.strictEqual(fs.existsSync(path.join(destinationParent, '零进展副本')), false);
    } finally {
      fs.writeSync = originalWrite;
    }
  })
);

test('detects replacement of the caller cwd and preserves committed copy truth', () =>
  withScratch(scratch => {
    const previous = process.cwd();
    const caller = path.join(scratch, 'caller');
    const sourceParent = path.join(scratch, 'source');
    const destinationParent = path.join(scratch, 'copies');
    fs.mkdirSync(caller);
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    const project = buildEligible(sourceParent);
    const finalTarget = path.join(destinationParent, '调用目录替换副本');
    process.chdir(caller);
    try {
      assert.throws(
        () => service.createWorkingCopy({
          rootPath: project.rootPath,
          destinationParent,
          copyName: '调用目录替换副本',
        }, {
          beforePublish() {
            fs.renameSync(caller, `${caller}.owned`);
            fs.mkdirSync(caller);
          },
        }),
        error => error.code === 'CWD_RESTORE_FAILED' &&
          error.committed === true
      );
      assert.strictEqual(
        JSON.parse(fs.readFileSync(path.join(finalTarget, service.COPY_MANIFEST), 'utf8')).schema,
        service.COPY_SCHEMA
      );
    } finally {
      process.chdir(previous);
    }
  })
);

test('rejects attempts to raise internal resource limits above contract maxima', () =>
  withScratch(scratch => {
    const project = buildEligible(scratch);
    for (const [name, maximum] of [
      ['maxFiles', service.MAX_FILES],
      ['maxFileBytes', service.MAX_FILE_BYTES],
      ['maxTotalBytes', service.MAX_TOTAL_BYTES],
      ['maxDepth', service.MAX_DEPTH],
    ]) {
      assert.throws(
        () => service.inspectProject(project.rootPath, { [name]: maximum + 1 }),
        error => error.code === 'INVALID_LIMIT'
      );
    }
  })
);

test('rejects duplicate CLI arguments instead of accepting the last value', () => {
  assert.throws(
    () => cli.parseArguments([
      '--project', '/first',
      '--project', '/second',
    ]),
    error => error.code === 'DUPLICATE_ARGUMENT'
  );
  assert.throws(
    () => cli.parseArguments([
      '--project', '/project',
      '--copy-to', '/one',
      '--copy-to', '/two',
      '--name', '副本',
    ]),
    error => error.code === 'DUPLICATE_ARGUMENT'
  );
});

console.log(`\n${passed}/48 author acceptance preflight checks passed.`);
