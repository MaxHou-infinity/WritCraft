#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const serviceModule = require('../src/main/markdown-trash-service');
const handlerModule = require('../src/main/markdown-trash-handler');

console.log('\nWritCraft Markdown trash verification');
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`  ✗ ${name}: ${error.stack || error.message}`);
  }
}

async function expectCode(code, fn) {
  await assert.rejects(fn, error => error?.code === code, `应抛出 ${code}`);
}

function compileHelper() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-markdown-trash-helper-'));
  const helperPath = path.join(scratch, 'markdown-trash-helper');
  childProcess.execFileSync('xcrun', [
    '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O0',
    path.join(__dirname, '..', 'native', 'markdown-trash-helper.c'),
    '-o', helperPath,
  ]);
  return { scratch, helperPath };
}

function rootIdentity(rootPath) {
  const stat = fs.lstatSync(rootPath, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function binding(rootPath, values = {}) {
  return {
    webContentsId: 7,
    projectInstanceId: 'project-a',
    rootPath,
    rootIdentity: values.rootIdentity || rootIdentity(rootPath),
    mutationGeneration: 3,
    navigationEpoch: 5,
    ...values,
  };
}

function fixture(helperPath, name = '回收区') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-markdown-trash-'));
  const project = projectService.createProjectAt(parent, name);
  projectService.createMarkdownFile(project.rootPath, 'chapters/draft.md', '# 可恢复\n');
  projectService.trashMarkdownFile(project.rootPath, 'chapters/draft.md');
  return {
    parent,
    project,
    service: serviceModule.createMarkdownTrashService({
      workerOptions: { helperPath },
      maxFileBytes: projectService.MAX_FILE_BYTES,
    }),
  };
}

function cleanup(item) {
  try { fs.rmSync(item.parent, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  const compiled = compileHelper();
  try {
    await test('list returns bounded public metadata and opaque tokens only', async () => {
      const item = fixture(compiled.helperPath);
      try {
        const result = await item.service.list(binding(item.project.rootPath));
        assert.strictEqual(result.schema, serviceModule.SCHEMA);
        assert.strictEqual(result.totalCount, 1);
        assert.strictEqual(result.totalBytes, Buffer.byteLength('# 可恢复\n'));
        assert.deepStrictEqual(Object.keys(result.items[0]).sort(),
          ['deletedAt', 'originalPath', 'sizeBytes', 'token']);
        assert.strictEqual(result.items[0].originalPath, 'chapters/draft.md');
        assert.match(result.items[0].token, serviceModule.TOKEN_RE);
        const serialized = JSON.stringify(result);
        for (const forbidden of ['trashPath', 'revision', 'manifest', 'rootPath', '"ino"', '"digest"', '.writcraft']) {
          assert.ok(!serialized.includes(forbidden), `不得暴露 ${forbidden}`);
        }
      } finally { cleanup(item); }
    });

    await test('exact current token restores bytes once and cannot replay', async () => {
      const item = fixture(compiled.helperPath);
      try {
        const listed = await item.service.list(binding(item.project.rootPath));
        const result = await item.service.restore(
          binding(item.project.rootPath),
          listed.items[0].token
        );
        assert.strictEqual(result.file.path, 'chapters/draft.md');
        assert.strictEqual(projectService.readFile(item.project.rootPath, result.file.path), '# 可恢复\n');
        assert.deepStrictEqual(projectService.listTrash(item.project.rootPath), []);
        await expectCode('MARKDOWN_TRASH_STALE', () =>
          item.service.restore(binding(item.project.rootPath), listed.items[0].token));
      } finally { cleanup(item); }
    });

    await test('native trash creates a recoverable first item and preserves exact bytes', async () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-markdown-trash-first-'));
      const project = projectService.createProjectAt(parent, '首次回收');
      const service = serviceModule.createMarkdownTrashService({
        workerOptions: { helperPath: compiled.helperPath },
        maxFileBytes: projectService.MAX_FILE_BYTES,
      });
      try {
        const file = projectService.createMarkdownFile(
          project.rootPath,
          'chapters/first.md',
          '# 第一次进入回收区\n'
        );
        const result = await service.trash(
          binding(project.rootPath),
          file.path,
          file.revision
        );
        assert.strictEqual(result.fromPath, file.path);
        assert.strictEqual(fs.existsSync(path.join(project.rootPath, 'chapters', 'first.md')), false);
        const listed = await service.list(binding(project.rootPath));
        assert.strictEqual(listed.items[0].originalPath, file.path);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    });

    await test('project, navigation, mutation, owner and root drift fail before restore', async () => {
      for (const drift of [
        { projectInstanceId: 'project-b' },
        { navigationEpoch: 6 },
        { mutationGeneration: 4 },
        { webContentsId: 8 },
        { rootIdentity: { dev: 9n, ino: 9n, mode: 0o40700n } },
      ]) {
        const item = fixture(compiled.helperPath);
        try {
          const listed = await item.service.list(binding(item.project.rootPath));
          await expectCode('MARKDOWN_TRASH_STALE', () =>
            item.service.restore(binding(item.project.rootPath, drift), listed.items[0].token));
          assert.strictEqual(projectService.listTrash(item.project.rootPath).length, 1);
        } finally { cleanup(item); }
      }
    });

    await test('destination conflict preserves both current file and trash entry', async () => {
      const item = fixture(compiled.helperPath);
      try {
        const listed = await item.service.list(binding(item.project.rootPath));
        projectService.createMarkdownFile(item.project.rootPath, 'chapters/draft.md', '# 新内容\n');
        await expectCode('FILE_EXISTS', () =>
          item.service.restore(binding(item.project.rootPath), listed.items[0].token));
        assert.strictEqual(projectService.readFile(item.project.rootPath, 'chapters/draft.md'), '# 新内容\n');
        assert.strictEqual(projectService.listTrash(item.project.rootPath).length, 1);
      } finally { cleanup(item); }
    });

    await test('same-inode rewrite after list is stale and never restores changed bytes', async () => {
      const item = fixture(compiled.helperPath);
      try {
        const listed = await item.service.list(binding(item.project.rootPath));
        const entry = projectService.listTrash(item.project.rootPath)[0];
        const target = path.join(item.project.rootPath, ...entry.trashPath.split('/'));
        fs.writeFileSync(target, '# 被篡改\n');
        await expectCode('MARKDOWN_TRASH_STALE', () =>
          item.service.restore(binding(item.project.rootPath), listed.items[0].token));
        assert.ok(!fs.existsSync(path.join(item.project.rootPath, 'chapters', 'draft.md')));
      } finally { cleanup(item); }
    });

    await test('symlinked private trash directory fails closed before manifest disclosure', async () => {
      const item = fixture(compiled.helperPath);
      try {
        const trash = path.join(item.project.rootPath, '.writcraft', 'trash');
        const held = `${trash}-held`;
        fs.renameSync(trash, held);
        fs.symlinkSync(held, trash);
        await assert.rejects(
          item.service.list(binding(item.project.rootPath)),
          error => ['MARKDOWN_TRASH_UNAVAILABLE', 'MARKDOWN_TRASH_RECOVERY_REQUIRED'].includes(error?.code)
        );
      } finally { cleanup(item); }
    });

    await test('a second list revokes older window tokens', async () => {
      const item = fixture(compiled.helperPath);
      try {
        const first = await item.service.list(binding(item.project.rootPath));
        await item.service.list(binding(item.project.rootPath));
        await expectCode('MARKDOWN_TRASH_STALE', () =>
          item.service.restore(binding(item.project.rootPath), first.items[0].token));
      } finally { cleanup(item); }
    });

    await test('item and aggregate budgets fail before unbounded item inspection', async () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-markdown-trash-budget-'));
      const project = projectService.createProjectAt(parent, '容量');
      const privateRoot = path.join(project.rootPath, '.writcraft');
      const trash = path.join(privateRoot, 'trash');
      fs.chmodSync(privateRoot, 0o700);
      fs.mkdirSync(trash, { mode: 0o700 });
      try {
        const manifest = {
          schema: projectService.TRASH_SCHEMA,
          schemaVersion: 1,
          entries: Array.from({ length: serviceModule.MAX_ITEMS + 1 }, (_, index) => ({
            id: `123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`,
            originalPath: `chapter-${index}.md`,
            trashPath: `.writcraft/trash/123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}.md`,
            deletedAt: new Date().toISOString(),
            revision: 'a'.repeat(64),
            bytes: 1,
          })),
        };
        fs.writeFileSync(path.join(trash, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
        const service = serviceModule.createMarkdownTrashService({
          workerOptions: { helperPath: compiled.helperPath },
        });
        await expectCode('MARKDOWN_TRASH_CORRUPT', () =>
          service.list(binding(project.rootPath)));
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    });

    await test('an unresolved journal dynamically blocks every shared Main mutation guard until reconciliation clears', async () => {
      let recoveryState = 'RECOVERY_REQUIRED';
      const service = serviceModule.createMarkdownTrashService({
        workerFactory: () => ({
          async ready() {},
          async reconcile() { return { state: recoveryState }; },
          close() {},
        }),
      });
      const project = {
        instanceId: 'project-recovery-lock',
        rootPath: '/private/recovery-lock',
        rootIdentity: { dev: 1n, ino: 2n, mode: 0o40700n },
      };
      assert.deepStrictEqual(await service.bindProject(project), {
        ok: false,
        state: 'RECOVERY_REQUIRED',
      });
      assert.throws(
        () => service.assertMutationAvailable(project),
        error => error?.code === 'MARKDOWN_TRASH_RECOVERY_REQUIRED'
      );
      recoveryState = 'CLEAR';
      assert.deepStrictEqual(await service.bindProject(project), {
        ok: true,
        state: 'CLEAR',
      });
      assert.strictEqual(service.assertMutationAvailable(project), project);
    });

    await test('handler settles watcher authority and derives root instead of accepting Renderer paths', async () => {
      const calls = [];
      let generation = 3;
      const identity = { dev: 1n, ino: 2n, mode: 0o40700n };
      const service = {
        async list(value) { calls.push(['list', value]); return { ok: true }; },
        async trash(value, relPath, revision) {
          calls.push(['trash', value, relPath, revision]);
          return { ok: true };
        },
        async restore(value, token) { calls.push(['restore', value, token]); return { ok: true }; },
      };
      const handler = handlerModule.createMarkdownTrashHandler({
        assertTrustedSender(event) {
          if (!event?.sender?.trusted) throw new Error('UNTRUSTED');
        },
        getCurrentProject: () => ({
          instanceId: 'project-a',
          rootPath: '/canonical/project',
          rootIdentity: identity,
        }),
        getMutationGeneration: () => generation,
        getNavigationEpoch: () => 5,
        async settleListAuthority() { generation = 4; },
        trashService: service,
      });
      const event = { sender: { id: 7, trusted: true } };
      await handler.list(event, 'project-a');
      await handler.trash(event, 'chapters/a.md', 'b'.repeat(64));
      await handler.restore(event, 'project-a', `mti_${'a'.repeat(48)}`);
      const settled = binding('/canonical/project', {
        mutationGeneration: 4,
        rootIdentity: identity,
      });
      assert.deepStrictEqual(calls, [
        ['list', settled],
        ['trash', settled, 'chapters/a.md', 'b'.repeat(64)],
        ['restore', settled, `mti_${'a'.repeat(48)}`],
      ]);
      await expectCode('MARKDOWN_TRASH_STALE', () => handler.list(event, 'project-b'));
    });
  } finally {
    fs.rmSync(compiled.scratch, { recursive: true, force: true });
  }

  if (!process.exitCode) {
    console.log(`\n✅ Markdown trash ${passed}/${passed} checks passed.\n`);
  }
})().catch(error => {
  process.exitCode = 1;
  console.error(error.stack || error.message);
});
