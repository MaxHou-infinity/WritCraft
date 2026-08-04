'use strict';

// Stage-B acceptance boundary: exercise the catalog against a real project
// tree and the production ProjectService.  This deliberately does not call a
// provider or expose manuscript content; it proves only Main-owned candidate
// discovery, source/entity locators, and the revision snapshot carried by the
// catalog.  A separate Main IPC test owns opaque-token expiry semantics.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectService = require('../src/main/project-service');
const catalogService = require('../src/main/context-catalog-service');

const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-context-catalog-'));

function write(relativePath, content) {
  const absolute = path.join(rootPath, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolute, content, { encoding: 'utf8', mode: 0o600 });
}

function cleanup() {
  fs.rmSync(rootPath, { recursive: true, force: true });
}

try {
  write('edit.md', '# 项目 Prompt\n\n围绕人物成长展开。');
  write('chapters/01-opening.md', '# 开篇\n\n“林夏”在 2026 年开始记录。');
  write('references/guide.md', '---\ntype: source\ntitle: 采访资料\n---\n# 采访资料\n\n只读来源。');

  const base = {
    projectService,
    rootPath,
    projectInstanceId: 'instance_0123456789abcdef01234567',
    mutationGeneration: 11,
  };

  const sourceCatalog = catalogService.listContextCandidates({ ...base, query: 'source' });
  const source = sourceCatalog.candidates.find(candidate => candidate.kind === 'source');
  assert(source, '真实项目应返回来源候选');
  assert.match(source.insertText, /^@source: "src_[a-f0-9]{20}"$/);
  assert.strictEqual(source.locator.filePath, 'references/guide.md');
  assert.match(source.locator.revision, /^[a-f0-9]{64}$/);

  const entityCatalog = catalogService.listContextCandidates({ ...base, query: 'entity' });
  const entity = entityCatalog.candidates.find(candidate => candidate.kind === 'entity' && candidate.label === '林夏');
  assert(entity, '真实项目应返回实体候选');
  assert.match(entity.insertText, /^@entity: "node_[a-f0-9]{16}"$/);
  assert.match(entity.locator.entityId, /^node_[a-f0-9]{16}$/);
  assert(!Object.prototype.hasOwnProperty.call(entity, 'content'));
  assert(!Object.prototype.hasOwnProperty.call(entity, 'rootPath'));

  const sectionCatalog = catalogService.listContextCandidates({ ...base, query: '开篇' });
  const section = sectionCatalog.candidates.find(candidate => candidate.kind === 'section');
  assert(section, '真实项目应返回章节/段落候选');
  assert.match(section.locator.revision, /^[a-f0-9]{64}$/);
  assert.strictEqual(sectionCatalog.projectInstanceId, base.projectInstanceId);
  assert.strictEqual(sectionCatalog.mutationGeneration, base.mutationGeneration);

  const serialized = JSON.stringify({ source, entity, section });
  assert(!serialized.includes(rootPath), '候选不得泄露绝对项目路径');
  assert(!serialized.includes('林夏”在 2026 年开始记录'), '候选不得返回正文');

  console.log('✓ real project source/entity/section candidates remain bounded and revision-bound');
  console.log('\n1/1 real-project context catalog checks passed.');
} finally {
  cleanup();
}
