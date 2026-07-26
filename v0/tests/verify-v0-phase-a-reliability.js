#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const service = require('../src/main/project-service');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8');
const workspace = fs.readFileSync(path.join(root, 'src/renderer/workspace.js'), 'utf8');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-phase-a-reliability-'));
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function throwsCode(fn, code) {
  assert.throws(fn, error => error && error.code === code, `expected ${code}`);
}

console.log('\nPhase A reliability verification');

try {
  check('opens an ordinary Markdown directory without edit.md or existing metadata', () => {
    const ordinary = path.join(scratch, 'ordinary-notes');
    fs.mkdirSync(ordinary);
    fs.mkdirSync(path.join(ordinary, 'chapters'));
    fs.writeFileSync(path.join(ordinary, 'chapters', '01.md'), '# Existing writing\n');
    assert(!fs.existsSync(path.join(ordinary, '.writcraft')));
    const opened = service.openProject(ordinary);
    assert.equal(opened.name, 'ordinary-notes');
    assert.match(opened.projectId, /^legacy_/);
    assert.deepEqual(service.loadWorkspace(ordinary), {
      tabs: ['chapters/01.md'],
      activePath: 'chapters/01.md',
      files: { 'chapters/01.md': { cursorOffset: 0, scrollTop: 0 } },
    });
    assert(!fs.existsSync(path.join(ordinary, '.writcraft')), 'read/open must not create metadata');
  });

  check('rejects a directory that has no public Markdown while allowing explicit prompt adoption', () => {
    const empty = path.join(scratch, 'empty');
    fs.mkdirSync(empty);
    fs.writeFileSync(path.join(empty, 'notes.txt'), 'not markdown');
    throwsCode(() => service.openProject(empty), 'NOT_WRITCRAFT_PROJECT');
    const ordinary = path.join(scratch, 'adopt');
    fs.mkdirSync(ordinary);
    fs.writeFileSync(path.join(ordinary, 'draft.md'), '# Draft\n');
    const created = service.createEditPrompt(ordinary);
    assert.equal(created.path, 'edit.md');
    assert.equal(created.frontMatter.status, 'valid');
    assert.match(service.readFile(ordinary, 'edit.md'), /schema: writcraft\.edit\/v1/);
    throwsCode(() => service.createEditPrompt(ordinary), 'FILE_EXISTS');
  });

  check('reports edit.md Front Matter errors as bounded structured diagnostics', () => {
    const missing = service.inspectEditFrontMatter('# No metadata\n');
    assert.equal(missing.status, 'missing');
    assert.equal(missing.diagnostics[0].code, 'FRONT_MATTER_MISSING');
    const unclosed = service.inspectEditFrontMatter('---\nschema: writcraft.edit/v1\n');
    assert.equal(unclosed.status, 'invalid');
    assert.equal(unclosed.diagnostics[0].code, 'FRONT_MATTER_UNCLOSED');
    const invalid = service.inspectEditFrontMatter('---\nschema writcraft.edit/v1\ntitle: A\ntitle: B\n---\n');
    assert.equal(invalid.status, 'invalid');
    assert.deepEqual(invalid.diagnostics.map(item => item.code), ['FRONT_MATTER_INVALID_LINE', 'FRONT_MATTER_DUPLICATE_KEY', 'EDIT_SCHEMA_MISSING']);
    const unsupported = service.inspectEditFrontMatter('---\nschema: other/v9\n---\n');
    assert.equal(unsupported.status, 'invalid');
    assert.equal(unsupported.diagnostics[0].code, 'EDIT_SCHEMA_UNSUPPORTED');
    const shifted = service.inspectEditFrontMatter('---\ntitle: X\nschema: other/v9\n---\n');
    assert.equal(shifted.diagnostics.find(item => item.code === 'EDIT_SCHEMA_UNSUPPORTED').line, 3);
    const valid = service.inspectEditFrontMatter('---\nschema: writcraft.edit/v1\ntitle: "Safe"\n---\n\n# Body\n');
    assert.equal(valid.status, 'valid');
    assert.equal(valid.data.title, 'Safe');
    assert.deepEqual(valid.diagnostics, []);
  });

  check('Front Matter repair proposal preserves legacy fields and body without writing', () => {
    const legacy = '---\nschema: writcraft.edit/v0\ncustom: keep-me\n---\n\n# 正文\n不要改动。\n';
    const proposal = service.proposeEditFrontMatterRepair(legacy);
    assert.equal(proposal.status, 'ready');
    assert.match(proposal.content, /schema: writcraft\.edit\/v1/);
    assert.match(proposal.content, /custom: keep-me/);
    assert.match(proposal.content, /# 正文\n不要改动。/);
    assert.equal(service.inspectEditFrontMatter(proposal.content).status, 'valid');
    const missing = service.proposeEditFrontMatterRepair('# 无元数据\n');
    assert.match(missing.content, /^---\nschema: writcraft\.edit\/v1\n---\n\n# 无元数据/);
    assert.throws(
      () => service.proposeEditFrontMatterRepair('---\nschema: writcraft.edit/v0\n'),
      error => error.code === 'EDIT_PROMPT_MANUAL_REPAIR_REQUIRED'
    );
    const warningOnly = '---\nschema: writcraft.edit/v1\n  nested: ignored\n---\n\n# 正文\n';
    const warningProposal = service.proposeEditFrontMatterRepair(warningOnly);
    assert.equal(warningProposal.status, 'not_needed');
    assert.equal(warningProposal.content, warningOnly);
  });

  check('read/write responses carry edit.md diagnostics without blocking Markdown access', () => {
    const project = service.createProjectAt(scratch, 'frontmatter-read');
    const first = service.readFileWithRevision(project.rootPath, 'edit.md');
    assert.equal(first.frontMatter.status, 'valid');
    const saved = service.atomicWriteFile(project.rootPath, 'edit.md', '---\nschema: wrong/v1\n---\n\n# Still editable\n', first.revision);
    assert.equal(saved.frontMatter.status, 'invalid');
    assert.match(service.readFile(project.rootPath, 'edit.md'), /Still editable/);
  });

  check('expectedRevision is checked again immediately before atomic rename', () => {
    const project = service.createProjectAt(scratch, 'double-check');
    service.createMarkdownFile(project.rootPath, 'chapter.md', 'disk v1');
    const snapshot = service.readFileWithRevision(project.rootPath, 'chapter.md');
    const absolute = path.join(project.rootPath, 'chapter.md');
    throwsCode(() => service.atomicWriteFile(project.rootPath, 'chapter.md', 'local draft', snapshot.revision, {
      beforeSecondRevisionCheck: () => fs.writeFileSync(absolute, 'external v2'),
    }), 'FILE_CONFLICT');
    assert.equal(fs.readFileSync(absolute, 'utf8'), 'external v2');
    const externalSnapshot = service.readFileWithRevision(project.rootPath, 'chapter.md');
    throwsCode(() => service.atomicWriteFile(project.rootPath, 'chapter.md', 'must not recreate', externalSnapshot.revision, {
      beforeSecondRevisionCheck: () => fs.unlinkSync(absolute),
    }), 'FILE_CONFLICT');
    assert(!fs.existsSync(absolute), 'conditional save must not recreate a concurrently deleted file');
    assert.deepEqual(fs.readdirSync(project.rootPath).filter(name => name.endsWith('.tmp')), []);
  });

  check('explicit conflict overwrite is revision-bound and fails closed on another disk change', () => {
    const project = service.createProjectAt(scratch, 'override');
    service.createMarkdownFile(project.rootPath, 'chapter.md', 'disk v1');
    const reviewed = service.readFileWithRevision(project.rootPath, 'chapter.md');
    const written = service.overwriteConflictedFile(project.rootPath, 'chapter.md', 'chosen local', reviewed.revision);
    assert.equal(service.readFile(project.rootPath, 'chapter.md'), 'chosen local');
    assert.match(written.revision, /^[a-f0-9]{64}$/);
    fs.writeFileSync(path.join(project.rootPath, 'chapter.md'), 'external v3');
    throwsCode(() => service.overwriteConflictedFile(project.rootPath, 'chapter.md', 'stale local', written.revision), 'FILE_CONFLICT');
    throwsCode(() => service.overwriteConflictedFile(project.rootPath, 'chapter.md', 'unsafe', null), 'CONFIRMATION_REQUIRED');
    assert.equal(service.readFile(project.rootPath, 'chapter.md'), 'external v3');
  });

  check('project-scoped recovery is atomic, bounded, private and content-addressed by safe path', () => {
    const project = service.createProjectAt(scratch, 'recovery');
    service.createMarkdownFile(project.rootPath, 'chapters/01.md', 'disk');
    const revision = service.readFileWithRevision(project.rootPath, 'chapters/01.md').revision;
    const saved = service.writeRecovery(project.rootPath, 'chapters/01.md', 'unsaved text', revision);
    assert.equal(saved.path, 'chapters/01.md');
    const recovered = service.readRecovery(project.rootPath, 'chapters/01.md');
    assert.equal(recovered.content, 'unsaved text');
    assert.equal(recovered.baseRevision, revision);
    const listed = service.listRecoveries(project.rootPath);
    assert.deepEqual(listed.map(item => item.path), ['chapters/01.md']);
    assert(!JSON.stringify(listed).includes('unsaved text'), 'list must not expose recovery content');
    assert(!JSON.stringify(listed).includes(project.rootPath), 'recovery API must not expose root paths');
    const files = fs.readdirSync(path.join(project.rootPath, service.RECOVERY_DIR));
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9]{64}\.json$/);
    assert.deepEqual(files.filter(name => name.endsWith('.tmp')), []);
    assert.deepEqual(service.clearRecovery(project.rootPath, 'chapters/01.md'), { cleared: true });
    assert.equal(service.readRecovery(project.rootPath, 'chapters/01.md'), null);
  });

  check('recovery rejects unsafe paths, oversized content and symlinked metadata', () => {
    const project = service.createProjectAt(scratch, 'recovery-guards');
    throwsCode(() => service.writeRecovery(project.rootPath, '../outside.md', 'x', null), 'PATH_TRAVERSAL');
    throwsCode(() => service.writeRecovery(project.rootPath, 'safe.md', 'x'.repeat(service.MAX_RECOVERY_CONTENT_BYTES + 1), null), 'RECOVERY_TOO_LARGE');
    if (process.platform !== 'win32') {
      const unsafe = path.join(scratch, 'unsafe-recovery');
      const outside = path.join(scratch, 'outside-recovery');
      fs.mkdirSync(unsafe);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(unsafe, 'draft.md'), '# draft');
      fs.symlinkSync(outside, path.join(unsafe, '.writcraft'));
      throwsCode(() => service.writeRecovery(unsafe, 'draft.md', 'secret', null), 'SYMLINK_NOT_ALLOWED');
      assert.deepEqual(fs.readdirSync(outside), []);
    }
  });

  check('Main/preload/renderer expose only project-bound prompt, recovery and conflict actions', () => {
    for (const route of ['create-prompt', 'overwrite-conflict', 'recreate-deleted', 'write-recovery', 'read-recovery', 'list-recoveries', 'clear-recovery']) {
      assert(main.includes(`ipcMain.handle('writcraft:project:${route}'`), `missing ${route}`);
    }
    assert(main.includes('projectService.openProject(rootPath)'));
    assert(main.includes('projectPromptMissing: promptMissing'));
    assert(main.includes('requireCurrentProject()'));
    for (const method of ['createProjectPrompt:', 'overwriteConflict:', 'recreateDeleted:', 'writeRecovery:', 'readRecovery:', 'listRecoveries:', 'clearRecovery:']) {
      assert(preload.includes(method), `missing ${method}`);
    }
    assert(!preload.includes('recoveryRoot'));
    assert(workspace.includes('暂不创建，继续写作'));
    assert(workspace.includes('await bridge?.overwriteConflict?.(path, content, state.conflictRevision)'));
    assert(workspace.includes('bridge?.writeRecovery?.(path, content, revision || null)'));
    assert(workspace.includes('localStorage remains a'));
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed} Phase A reliability checks passed.`);
