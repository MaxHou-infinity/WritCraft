#!/usr/bin/env node
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const service = require(path.join(__dirname, '..', 'src/main/project-service.js'));
const changeSetService = require(path.join(__dirname, '..', 'src/main/changeset-service.js'));
const changeSetReviewService = require(path.join(__dirname, '..', 'src/main/changeset-review-service.js'));
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-migration-test-'));
let pass = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    pass += 1;
  } catch (error) {
    console.error(`  ✗ ${label}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function throwsCode(fn, code) {
  assert.throws(fn, error => error && error.code === code, `应抛出 ${code}`);
}

function makeRoot(name) {
  const root = path.join(scratch, name);
  fs.mkdirSync(root);
  return root;
}

console.log('════════ WritCraft V0 · Legacy migration verify ════════');

check('预览 editor.md 内容、目标与确认版本', () => {
  const root = makeRoot('preview');
  fs.writeFileSync(path.join(root, 'editor.md'), '# 旧项目规则\n');
  const preview = service.previewLegacyEditMigration(root);
  assert.equal(preview.status, 'ready');
  assert.equal(preview.canMigrate, true);
  assert.equal(preview.source.path, 'editor.md');
  assert.equal(preview.source.content, '# 旧项目规则\n');
  assert.equal(preview.targetPath, 'edit.md');
  assert.equal(preview.confirmationRevision, crypto.createHash('sha256').update('# 旧项目规则\n').digest('hex'));
});

check('未显式确认时绝不修改文件', () => {
  const root = makeRoot('confirmation');
  fs.writeFileSync(path.join(root, 'editor.md'), 'keep me');
  const revision = service.previewLegacyEditMigration(root).confirmationRevision;
  throwsCode(() => service.migrateLegacyEditFile(root, { expectedRevision: revision }), 'CONFIRMATION_REQUIRED');
  assert.equal(fs.readFileSync(path.join(root, 'editor.md'), 'utf8'), 'keep me');
  assert.equal(fs.existsSync(path.join(root, 'edit.md')), false);
});

check('确认后安全迁移，内容与文件模式保留', () => {
  const root = makeRoot('success');
  const source = path.join(root, 'editor.md');
  fs.writeFileSync(source, '# prompt\n');
  fs.chmodSync(source, 0o640);
  const revision = service.previewLegacyEditMigration(root).confirmationRevision;
  const result = service.migrateLegacyEditFile(root, { confirmed: true, expectedRevision: revision });
  assert.equal(result.status, 'migrated');
  assert.equal(result.file.path, 'edit.md');
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(root, 'edit.md'), 'utf8'), '# prompt\n');
  assert.equal(fs.statSync(path.join(root, 'edit.md')).mode & 0o777, 0o640);
});

check('已完成迁移重复确认幂等', () => {
  const root = makeRoot('idempotent');
  fs.writeFileSync(path.join(root, 'editor.md'), 'same');
  const revision = service.previewLegacyEditMigration(root).confirmationRevision;
  assert.equal(service.migrateLegacyEditFile(root, { confirmed: true, expectedRevision: revision }).status, 'migrated');
  assert.equal(service.migrateLegacyEditFile(root, { confirmed: true, expectedRevision: revision }).status, 'already_migrated');
  assert.equal(fs.readFileSync(path.join(root, 'edit.md'), 'utf8'), 'same');
});

check('双文件冲突只预览，绝不合并或覆盖', () => {
  const root = makeRoot('dual-file');
  fs.writeFileSync(path.join(root, 'editor.md'), 'legacy');
  fs.writeFileSync(path.join(root, 'edit.md'), 'authoritative');
  const preview = service.previewLegacyEditMigration(root);
  assert.equal(preview.status, 'conflict');
  assert.equal(preview.canMigrate, false);
  assert.equal(preview.source.content, 'legacy');
  assert.equal(preview.target.content, 'authoritative');
  throwsCode(() => service.migrateLegacyEditFile(root, {
    confirmed: true,
    expectedRevision: preview.source.revision,
  }), 'MIGRATION_CONFLICT');
  assert.equal(fs.readFileSync(path.join(root, 'editor.md'), 'utf8'), 'legacy');
  assert.equal(fs.readFileSync(path.join(root, 'edit.md'), 'utf8'), 'authoritative');
});

check('预览后源文件变更被 revision 拦截', () => {
  const root = makeRoot('revision-conflict');
  fs.writeFileSync(path.join(root, 'editor.md'), 'before');
  const revision = service.previewLegacyEditMigration(root).confirmationRevision;
  fs.writeFileSync(path.join(root, 'editor.md'), 'after');
  throwsCode(() => service.migrateLegacyEditFile(root, { confirmed: true, expectedRevision: revision }), 'FILE_CONFLICT');
  assert.equal(fs.readFileSync(path.join(root, 'editor.md'), 'utf8'), 'after');
  assert.equal(fs.existsSync(path.join(root, 'edit.md')), false);
});

check('预览后新建目标文件时绝不覆盖', () => {
  const root = makeRoot('target-race');
  fs.writeFileSync(path.join(root, 'editor.md'), 'legacy');
  const revision = service.previewLegacyEditMigration(root).confirmationRevision;
  fs.writeFileSync(path.join(root, 'edit.md'), 'racing writer');
  throwsCode(() => service.migrateLegacyEditFile(root, { confirmed: true, expectedRevision: revision }), 'MIGRATION_CONFLICT');
  assert.equal(fs.readFileSync(path.join(root, 'edit.md'), 'utf8'), 'racing writer');
  assert.equal(fs.readFileSync(path.join(root, 'editor.md'), 'utf8'), 'legacy');
});

check('拒绝 editor.md 或 edit.md 符号链接', () => {
  if (process.platform === 'win32') return;
  const outside = path.join(scratch, 'outside.md');
  fs.writeFileSync(outside, 'outside');
  const root = makeRoot('symlink');
  fs.symlinkSync(outside, path.join(root, 'editor.md'));
  throwsCode(() => service.previewLegacyEditMigration(root), 'SYMLINK_NOT_ALLOWED');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
});

check('无旧文件和只有新文件时状态可解释', () => {
  const empty = makeRoot('missing');
  assert.equal(service.previewLegacyEditMigration(empty).status, 'missing');
  const modern = makeRoot('modern');
  fs.writeFileSync(path.join(modern, 'edit.md'), 'modern');
  assert.equal(service.previewLegacyEditMigration(modern).status, 'not_needed');
});

check('edit.md Front Matter v0 修复走 reviewed ChangeSet，不调用文件名迁移', () => {
  const root = makeRoot('front-matter-v0');
  const legacyEdit = '---\nschema: writcraft.edit/v0\ntitle: "Legacy"\nlanguage: zh-CN\n---\n\n# 项目主旨\n\n保留正文。\n';
  fs.writeFileSync(path.join(root, 'edit.md'), legacyEdit);
  const snapshot = service.readFileWithRevision(root, 'edit.md');
  const repair = service.proposeEditFrontMatterRepair(snapshot.content);
  assert.equal(repair.status, 'ready');
  assert(repair.content.includes('schema: writcraft.edit/v1'));
  const changeSet = changeSetService.createChangeSet(
    [{ path: 'edit.md', content: snapshot.content, revision: snapshot.revision }],
    [{ path: 'edit.md', after: repair.content, summary: '迁移 edit.md Front Matter' }]
  );
  const review = changeSetReviewService.createReview(changeSet, { selectionPolicy: 'file' });
  const accepted = review.files.flatMap(file => file.hunks.map(hunk => hunk.id));
  const result = changeSetReviewService.applyDecision(service, root, changeSet, {
    schema: changeSetReviewService.DECISION_SCHEMA,
    changeSetId: review.changeSetId,
    acceptHunkIds: accepted,
    rejectHunkIds: [],
  }, { selectionPolicy: 'file' });
  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 1);
  assert(fs.readFileSync(path.join(root, 'edit.md'), 'utf8').includes('schema: writcraft.edit/v1'));
  assert.equal(fs.existsSync(path.join(root, 'editor.md')), false);
  const repairStart = mainSource.indexOf("ipcMain.handle('writcraft:project:propose-edit-prompt-repair'");
  const repairEnd = mainSource.indexOf("ipcMain.handle('writcraft:project:propose-changes'", repairStart);
  const repairRoute = mainSource.slice(repairStart, repairEnd);
  assert(repairRoute.includes('cacheReviewedChangeSet(changeSet, project'));
  assert(!repairRoute.includes('confirm-legacy-edit'));
  assert(!repairRoute.includes('migrateLegacyEditFile'));
});

check('只有可验证 WritCraft 元数据的缺 Prompt 项目可进入恢复模式', () => {
  const created = service.createProjectAt(scratch, 'recoverable-project');
  fs.unlinkSync(path.join(created.rootPath, 'edit.md'));
  assert.equal(service.openProjectForRecovery(created.rootPath).projectId, created.projectId);
  const ordinary = makeRoot('ordinary-missing-edit');
  fs.mkdirSync(path.join(ordinary, '.writcraft'));
  fs.writeFileSync(path.join(ordinary, '.writcraft', 'workspace.json'), '{"schema":"other"}');
  throwsCode(() => service.openProjectForRecovery(ordinary), 'NOT_WRITCRAFT_PROJECT');
});

check('localStorage 草稿纯函数规划不冲突公开 Markdown 路径', () => {
  const occupied = ['chapters/imported-draft.md', 'chapters/imported-draft-2.md'];
  const before = [...occupied];
  const plan = service.planLegacyDraftImport('# 恢复稿\n', 'chapters/imported-draft.md', occupied);
  assert.equal(plan.targetPath, 'chapters/imported-draft-3.md');
  assert.equal(plan.renamed, true);
  assert.equal(plan.content, '# 恢复稿\n');
  assert.deepEqual(occupied, before, '纯函数不应修改输入列表');
  throwsCode(() => service.planLegacyDraftImport('secret', '../outside.md', []), 'PATH_TRAVERSAL');
  throwsCode(() => service.planLegacyDraftImport('secret', '.writcraft/draft.md', []), 'PRIVATE_PATH');
  throwsCode(() => service.planLegacyDraftImport('secret', 'draft.txt', []), 'INVALID_EXTENSION');
});

try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}

if (!process.exitCode) console.log(`\n✅ 旧项目/草稿迁移行为安全检查 ${pass}/${pass} 全过`);
