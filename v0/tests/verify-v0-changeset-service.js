'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const {
  CHANGESET_SCHEMA,
  CHANGE_SELECTION_SCHEMA,
  MAX_CHANGE_FILES,
  MAX_REVIEW_BYTES,
  createChangeSet,
  validateChangeSet,
  preview,
  selectHunks,
  applyAll,
  acceptOne,
  rejectOne,
} = require('../src/main/changeset-service');

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

function revision(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function snapshot(path, content) {
  return { path, content, revision: revision(content) };
}

function expectCode(code, fn) {
  assert.throws(fn, error => error && error.code === code);
}

function sampleSet() {
  return createChangeSet(
    [snapshot('one.md', '# One\nold\n'), snapshot('chapters/two.markdown', '# Two\nbefore\n')],
    [
      { path: 'one.md', after: '# One\nnew\n', summary: '更新第一章' },
      { path: 'chapters/two.markdown', after: '# Two\nafter\n', summary: '更新第二章' },
    ]
  );
}

console.log('\nChangeSet service verification');

test('creates the v1 schema and a stable content-derived ID', () => {
  const first = sampleSet();
  const second = sampleSet();
  const reordered = createChangeSet(
    [snapshot('one.md', '# One\nold\n'), snapshot('chapters/two.markdown', '# Two\nbefore\n')],
    [
      { path: 'chapters/two.markdown', after: '# Two\nafter\n', summary: '更新第二章' },
      { path: 'one.md', after: '# One\nnew\n', summary: '更新第一章' },
    ]
  );
  assert.strictEqual(first.schema, CHANGESET_SCHEMA);
  assert.match(first.id, /^cs_[a-f0-9]{24}$/);
  assert.strictEqual(first.id, second.id);
  assert.strictEqual(first.id, reordered.id);
  assert.deepStrictEqual(validateChangeSet(first), first);
});

test('binds before and expectedRevision to trusted snapshots', () => {
  const snap = snapshot('chapter.md', 'trusted');
  const set = createChangeSet([snap], [{ path: 'chapter.md', after: 'next', summary: '修改' }]);
  assert.strictEqual(set.changes[0].before, 'trusted');
  assert.strictEqual(set.changes[0].expectedRevision, snap.revision);
  expectCode('SNAPSHOT_MISMATCH', () => createChangeSet(
    [snap],
    [{ path: 'chapter.md', before: 'invented', after: 'next', summary: '修改' }]
  ));
});

test('filters model no-ops before they can become reviewable or auditable changes', () => {
  const snap = snapshot('chapter.md', 'unchanged\n');
  const set = createChangeSet([snap], [{ path: 'chapter.md', after: snap.content, summary: '无实际修改' }]);
  assert.deepStrictEqual(set.changes, []);
  assert.deepStrictEqual(preview(set), []);
});

test('rejects arbitrary, hidden, non-Markdown and traversal paths', () => {
  const good = snapshot('allowed.md', 'a');
  expectCode('UNSNAPSHOTTED_PATH', () => createChangeSet([good], [
    { path: 'other.md', after: 'x', summary: '越权' },
  ]));
  for (const bad of ['.writcraft/state.md', 'dir/.secret.md', 'note.txt', '../escape.md', '/tmp/a.md', 'C:\\tmp\\a.md']) {
    expectCode(
      ['.writcraft/state.md', 'dir/.secret.md'].includes(bad) ? 'PRIVATE_PATH'
        : bad === 'note.txt' ? 'INVALID_EXTENSION'
          : bad === '../escape.md' ? 'PATH_TRAVERSAL' : 'ABSOLUTE_PATH',
      () => createChangeSet([good], [{ path: bad, after: 'x', summary: '非法路径' }])
    );
  }
});

test('rejects duplicate files and file-count overflow', () => {
  const snap = snapshot('same.md', 'a');
  expectCode('DUPLICATE_PATH', () => createChangeSet([snap], [
    { path: 'same.md', after: 'b', summary: '一' },
    { path: 'same.md', after: 'c', summary: '二' },
  ]));
  expectCode('DUPLICATE_PATH', () => createChangeSet([snap], [
    { path: 'same.md', after: 'a', summary: '试图用 no-op 隐藏重复路径' },
    { path: 'same.md', after: 'b', summary: '实际修改' },
  ]));
  const many = Array.from({ length: MAX_CHANGE_FILES + 1 }, (_, index) => snapshot(`f${index}.md`, ''));
  expectCode('TOO_MANY_FILES', () => createChangeSet(many, []));
});

test('detects content tampering through the stable ID', () => {
  const set = sampleSet();
  set.changes[0].after = 'tampered';
  expectCode('INVALID_ID', () => validateChangeSet(set));
});

test('renders a compact unified-style line preview', () => {
  const result = preview(sampleSet());
  assert.strictEqual(result.length, 2);
  assert.match(result[0].hunks[0].text, /^@@ -/);
  assert.match(result[0].hunks[0].text, /-old/);
  assert.match(result[0].hunks[0].text, /\+new/);
  assert.match(result[0].hunks[0].id, /^hk_[a-f0-9]{24}$/);
  assert(!Object.hasOwn(result[0].hunks[0], 'lines'));
  const structured = preview(sampleSet(), { structured: true });
  assert(Array.isArray(structured[0].hunks[0].lines));
  assert(!Object.hasOwn(structured[0].hunks[0], 'text'));
  expectCode('INVALID_PREVIEW_OPTIONS', () => preview(sampleSet(), { context: 1 }));
});

test('fails closed before publishing an oversized legacy or structured review projection', () => {
  const size = Math.floor(MAX_REVIEW_BYTES / 2) + 32 * 1024;
  const before = 'a'.repeat(size);
  const after = 'b'.repeat(size);
  const set = createChangeSet(
    [snapshot('giant.md', before)],
    [{ path: 'giant.md', after, summary: '超长单行修改' }],
  );
  expectCode('REVIEW_TOO_LARGE', () => preview(set));
  expectCode('REVIEW_TOO_LARGE', () => preview(set, { structured: true }));
});

test('builds stable independent hunks and reconstructs only the selected edits', () => {
  const before = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  const lines = before.trimEnd().split('\n');
  lines[1] = 'FIRST CHANGE';
  lines[20] = 'SECOND CHANGE';
  const after = lines.join('\n') + '\n';
  const set = createChangeSet(
    [snapshot('chapter.md', before)],
    [{ path: 'chapter.md', after, summary: '修改两处相隔较远的段落' }],
  );
  const firstPreview = preview(set);
  const secondPreview = preview(set);
  assert.strictEqual(firstPreview[0].hunks.length, 2);
  assert.deepStrictEqual(firstPreview, secondPreview);

  const partial = selectHunks(set, {
    schema: CHANGE_SELECTION_SCHEMA,
    files: [{ path: 'chapter.md', hunkIds: [firstPreview[0].hunks[0].id] }],
  });
  assert(partial.changes[0].after.includes('FIRST CHANGE'));
  assert(partial.changes[0].after.includes('line 21'));
  assert(!partial.changes[0].after.includes('SECOND CHANGE'));
  assert.strictEqual(partial.changes[0].before, before);
  assert.strictEqual(partial.changes[0].expectedRevision, revision(before));

  const complete = selectHunks(set, {
    schema: CHANGE_SELECTION_SCHEMA,
    files: [{ path: 'chapter.md', hunkIds: firstPreview[0].hunks.map(hunk => hunk.id) }],
  });
  assert.deepStrictEqual(complete, set);
});

test('reorders reversed Renderer hunk IDs into Main canonical patch order', () => {
  const original = Array.from({ length: 42 }, (_, index) => `line ${index + 1}`);
  const proposed = [...original];
  proposed[1] = 'FIRST';
  proposed[20] = 'MIDDLE';
  proposed[39] = 'LAST';
  const before = `${original.join('\n')}\n`;
  const set = createChangeSet(
    [snapshot('ordered.md', before)],
    [{ path: 'ordered.md', after: `${proposed.join('\n')}\n`, summary: '三处独立修改' }],
  );
  const hunks = preview(set)[0].hunks;
  assert.strictEqual(hunks.length, 3);
  const selected = selectHunks(set, {
    schema: CHANGE_SELECTION_SCHEMA,
    files: [{ path: 'ordered.md', hunkIds: [hunks[2].id, hunks[0].id] }],
  });
  const expected = [...original];
  expected[1] = 'FIRST';
  expected[39] = 'LAST';
  assert.strictEqual(selected.changes[0].after, `${expected.join('\n')}\n`);
});

test('preserves CRLF, Unicode and the exact EOF-newline state when selecting hunks', () => {
  const originalLines = Array.from({ length: 24 }, (_, index) => `第 ${index + 1} 行`);
  const changedLines = [...originalLines];
  changedLines[1] = '第一处改写 😀';
  changedLines[20] = '第二处改写';
  const before = originalLines.join('\r\n');
  const after = changedLines.join('\r\n');
  const set = createChangeSet(
    [snapshot('unicode.md', before)],
    [{ path: 'unicode.md', after, summary: '保留换行格式并修改中文' }],
  );
  const shown = preview(set)[0];
  assert.strictEqual(shown.hunks.length, 2);
  const selected = selectHunks(set, {
    schema: CHANGE_SELECTION_SCHEMA,
    files: [{ path: 'unicode.md', hunkIds: [shown.hunks[0].id] }],
  });
  const expected = [...originalLines];
  expected[1] = '第一处改写 😀';
  assert.strictEqual(selected.changes[0].after, expected.join('\r\n'));
  assert(selected.changes[0].after.includes('\r\n'));
  assert(!selected.changes[0].after.endsWith('\r\n'));
});

test('hunk selection rejects smuggling, duplicates, unknown ids and empty work', () => {
  const set = sampleSet();
  const shown = preview(set);
  const one = { path: shown[0].path, hunkIds: [shown[0].hunks[0].id] };
  expectCode('INVALID_SELECTION', () => selectHunks(set, { schema: CHANGE_SELECTION_SCHEMA, files: [one], patch: 'forged' }));
  expectCode('NO_CHANGES_SELECTED', () => selectHunks(set, { schema: CHANGE_SELECTION_SCHEMA, files: [] }));
  expectCode('DUPLICATE_PATH', () => selectHunks(set, { schema: CHANGE_SELECTION_SCHEMA, files: [one, one] }));
  expectCode('DUPLICATE_HUNK', () => selectHunks(set, {
    schema: CHANGE_SELECTION_SCHEMA,
    files: [{ path: one.path, hunkIds: [one.hunkIds[0], one.hunkIds[0]] }],
  }));
  expectCode('HUNK_NOT_FOUND', () => selectHunks(set, {
    schema: CHANGE_SELECTION_SCHEMA,
    files: [{ path: one.path, hunkIds: ['hk_' + '0'.repeat(24)] }],
  }));
  expectCode('CHANGE_NOT_FOUND', () => selectHunks(set, {
    schema: CHANGE_SELECTION_SCHEMA,
    files: [{ path: 'missing.md', hunkIds: one.hunkIds }],
  }));
});

test('whole-file policy is enforced by the service rather than trusted to the UI', () => {
  const before = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  const lines = before.trimEnd().split('\n');
  lines[1] = 'FIRST CHANGE';
  lines[20] = 'SECOND CHANGE';
  const set = createChangeSet(
    [snapshot('edit.md', before)],
    [{ path: 'edit.md', after: lines.join('\n') + '\n', summary: '结构化更新项目 Prompt' }],
  );
  const hunks = preview(set)[0].hunks;
  expectCode('PARTIAL_SELECTION_FORBIDDEN', () => selectHunks(set, {
    schema: CHANGE_SELECTION_SCHEMA,
    files: [{ path: 'edit.md', hunkIds: [hunks[0].id] }],
  }, { selectionPolicy: 'file' }));
  assert.deepStrictEqual(selectHunks(set, {
    schema: CHANGE_SELECTION_SCHEMA,
    files: [{ path: 'edit.md', hunkIds: hunks.map(hunk => hunk.id) }],
  }, { selectionPolicy: 'file' }), set);
});

test('acceptOne and rejectOne derive new ChangeSets without writing', () => {
  const set = sampleSet();
  const accepted = acceptOne(set, 'one.md');
  const rejected = rejectOne(set, 'one.md');
  assert.deepStrictEqual(accepted.changes.map(change => change.path), ['one.md']);
  assert.deepStrictEqual(rejected.changes.map(change => change.path), ['chapters/two.markdown']);
  assert.notStrictEqual(accepted.id, set.id);
  expectCode('CHANGE_NOT_FOUND', () => rejectOne(set, 'missing.md'));
});

test('preflights every revision and writes nothing on conflict', () => {
  const set = sampleSet();
  let writes = 0;
  const service = {
    readFileWithRevision(_root, target) {
      const change = set.changes.find(item => item.path === target);
      return target === 'chapters/two.markdown'
        ? { content: 'external edit', revision: revision('external edit') }
        : { content: change.before, revision: change.expectedRevision };
    },
    atomicWriteFile() { writes += 1; },
  };
  const result = applyAll(service, '/project', set);
  assert.strictEqual(result.status, 'conflict');
  assert.strictEqual(result.path, 'chapters/two.markdown');
  assert.strictEqual(writes, 0);
});

test('applies all changes atomically through ProjectService revisions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-changeset-'));
  try {
    fs.mkdirSync(path.join(root, 'chapters'));
    fs.writeFileSync(path.join(root, 'one.md'), '# One\nold\n');
    fs.writeFileSync(path.join(root, 'chapters', 'two.markdown'), '# Two\nbefore\n');
    const result = applyAll(projectService, root, sampleSet());
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'applied');
    assert.strictEqual(fs.readFileSync(path.join(root, 'one.md'), 'utf8'), '# One\nnew\n');
    assert.strictEqual(fs.readFileSync(path.join(root, 'chapters', 'two.markdown'), 'utf8'), '# Two\nafter\n');
    assert.strictEqual(result.applied.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rolls back earlier writes with their newly returned revisions', () => {
  const set = sampleSet();
  const data = new Map(set.changes.map(change => [change.path, change.before]));
  const writeLog = [];
  const service = {
    readFileWithRevision(_root, target) {
      const content = data.get(target);
      return { content, revision: revision(content) };
    },
    atomicWriteFile(_root, target, content, expectedRevision) {
      const current = data.get(target);
      assert.strictEqual(expectedRevision, revision(current));
      writeLog.push({ target, content });
      if (target === 'chapters/two.markdown' && content === '# Two\nafter\n') {
        throw Object.assign(new Error('simulated disk failure'), { code: 'DISK_FAILURE' });
      }
      data.set(target, content);
      return { path: target, revision: revision(content) };
    },
  };
  const result = applyAll(service, '/project', set);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 'rolled_back');
  assert.strictEqual(data.get('one.md'), '# One\nold\n');
  assert.deepStrictEqual(result.rolledBack.map(item => item.path), ['one.md']);
  assert.strictEqual(writeLog.length, 3);
});

console.log(`\n${passed}/${passed} ChangeSet checks passed.\n`);
