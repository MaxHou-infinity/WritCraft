// WritCraft project filesystem service
//
// This module deliberately has no Electron dependency so its security boundary
// can be exercised with ordinary Node tests. Renderer code never supplies a
// project root; main.js owns the active root and only accepts relative paths.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const EDIT_FILE = 'edit.md';
const LEGACY_EDIT_FILE = 'editor.md';
const META_DIR = '.writcraft';
const META_FILE = path.join(META_DIR, 'project.json');
const WORKSPACE_FILE = path.join(META_DIR, 'workspace.json');
const TRASH_DIR = path.join(META_DIR, 'trash');
const TRASH_MANIFEST_FILE = path.join(TRASH_DIR, 'manifest.json');
const RECOVERY_DIR = path.join(META_DIR, 'recovery');
const PROJECT_SCHEMA = 'writcraft.project/v1';
const WORKSPACE_SCHEMA = 'writcraft.workspace/v1';
const TRASH_SCHEMA = 'writcraft.trash/v1';
const RECOVERY_SCHEMA = 'writcraft.recovery/v1';
const RECENT_SCHEMA = 'writcraft.recent/v1';
const RECENT_FILE = 'recent-project.json';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 256 * 1024;
const MAX_RECENT_BYTES = 64 * 1024;
const MAX_WORKSPACE_TABS = 100;
const MAX_TREE_ENTRIES = 5000;
const MAX_TREE_DEPTH = 32;
const MAX_TRASH_ENTRIES = 1000;
const MAX_RECOVERY_ENTRIES = 100;
const MAX_RECOVERY_CONTENT_BYTES = 4 * 1024 * 1024;
const MAX_RECOVERY_TOTAL_BYTES = 20 * 1024 * 1024;

class ProjectServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProjectServiceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProjectServiceError(code, message);
}

function assertDirectory(directory, label = '目录') {
  if (typeof directory !== 'string' || !directory.trim()) {
    fail('INVALID_PATH', `${label}无效`);
  }
  const absolute = path.resolve(directory);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch (error) {
    fail('NOT_FOUND', `${label}不存在`);
  }
  if (!stat.isDirectory()) fail('NOT_DIRECTORY', `${label}不是文件夹`);
  return fs.realpathSync(absolute);
}

function validateProjectName(name) {
  if (typeof name !== 'string') fail('INVALID_NAME', '项目名称无效');
  const clean = name.trim();
  if (!clean || clean === '.' || clean === '..' || clean.length > 120) {
    fail('INVALID_NAME', '项目名称应为 1–120 个字符');
  }
  if (/[\x00-\x1f\\/:*?"<>|]/.test(clean)) {
    fail('INVALID_NAME', '项目名称包含不允许的字符');
  }
  return clean;
}

function validateRelativePath(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim() || relPath.includes('\0')) {
    fail('INVALID_PATH', '文件路径无效');
  }
  // Check both path dialects so a Windows path cannot become dangerous after
  // a project is moved between platforms.
  if (path.posix.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) {
    fail('ABSOLUTE_PATH', '只允许项目内相对路径');
  }
  if (/[/\\]{2,}/.test(relPath)) {
    fail('PATH_TRAVERSAL', '路径不能包含空段');
  }
  const parts = relPath.split(/[\\/]+/);
  if (parts.some(part => !part || part === '.' || part === '..')) {
    fail('PATH_TRAVERSAL', '路径不能包含空段、. 或 ..');
  }
  return parts;
}

function assertPublicMarkdownPath(relPath) {
  const parts = validateRelativePath(relPath);
  if (parts.some(part => part.startsWith('.'))) {
    fail('PRIVATE_PATH', '不能通过编辑器访问项目内部或隐藏文件');
  }
  if (!/\.(?:md|markdown)$/i.test(parts[parts.length - 1])) {
    fail('INVALID_EXTENSION', '编辑器只允许访问 Markdown 文件');
  }
  return parts.join('/');
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveInside(rootPath, relPath, options = {}) {
  const root = assertDirectory(rootPath, '项目目录');
  const parts = validateRelativePath(relPath);
  const candidate = path.resolve(root, ...parts);
  if (!isWithin(root, candidate)) fail('PATH_TRAVERSAL', '路径已越出项目目录');

  // Refuse every symlink in the path. Merely checking realpath(candidate) is
  // insufficient for a not-yet-created file whose parent is a symlink.
  let cursor = root;
  const stopBeforeLeaf = options.allowMissingLeaf === true;
  const checkedParts = stopBeforeLeaf ? parts.slice(0, -1) : parts;
  for (const part of checkedParts) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) {
      if (options.allowMissingParents) continue;
      fail('NOT_FOUND', '文件或上级目录不存在');
    }
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '项目路径不能经过符号链接');
  }
  if (stopBeforeLeaf && fs.existsSync(candidate)) {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '不能操作符号链接文件');
  }
  return { root, absolute: candidate, relative: parts.join('/') };
}

function assertContent(content) {
  if (typeof content !== 'string') fail('INVALID_CONTENT', '文件内容必须是文本');
  const size = Buffer.byteLength(content, 'utf8');
  if (size > MAX_FILE_BYTES) {
    fail('FILE_TOO_LARGE', `单个文件不能超过 ${MAX_FILE_BYTES} 字节`);
  }
  return size;
}

function atomicWriteAbsolute(absolute, content, options = {}) {
  assertContent(content);
  const directory = path.dirname(absolute);
  const basename = path.basename(absolute);
  const temporary = path.join(
    directory,
    `.${basename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let fd;
  try {
    const mode = fs.existsSync(absolute) ? fs.statSync(absolute).mode & 0o777 : 0o600;
    fd = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(fd, content, { encoding: 'utf8' });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (typeof options.beforeRename === 'function') options.beforeRename();
    fs.renameSync(temporary, absolute);

    // Persist the directory entry too. Some platforms/filesystems do not allow
    // opening a directory, so failure here must not turn a completed rename
    // into a false write failure.
    syncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function syncDirectory(directory) {
  try {
    const dirFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (_) {}
}

function readBoundedAbsolute(absolute) {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let fd;
  try {
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail('NOT_FILE', '目标不是文件');
    if (stat.size > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', '文件超过读取大小限制');

    // Read at most limit + 1 from the already-open descriptor. This also
    // catches a file that grows after fstat, without a stat/read TOCTOU gap.
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let total = 0;
    while (total <= MAX_FILE_BYTES) {
      const bytes = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (bytes === 0) break;
      total += bytes;
    }
    if (total > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', '文件超过读取大小限制');
    return buffer.subarray(0, total).toString('utf8');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readInternalFile(rootPath, relPath) {
  const target = resolveInside(rootPath, relPath);
  return readBoundedAbsolute(target.absolute);
}

function projectDescriptor(rootPath) {
  const root = assertDirectory(rootPath, '项目目录');
  let metadata = {};
  try {
    // Use the same guarded read path as user files; metadata must not become a
    // hidden symlink escape hatch when opening an untrusted project folder.
    metadata = JSON.parse(readInternalFile(root, META_FILE));
  } catch (_) {}
  return {
    name: typeof metadata.name === 'string' && metadata.name.trim()
      ? metadata.name
      : path.basename(root),
    projectId: typeof metadata.projectId === 'string' && metadata.projectId.trim()
      ? metadata.projectId
      : `legacy_${crypto.createHash('sha256').update(root).digest('hex').slice(0, 24)}`,
    instanceId: `instance_${crypto.createHash('sha256').update(root).digest('hex').slice(0, 24)}`,
    rootPath: root,
  };
}

function makeEditTemplate(name) {
  return `---\nschema: writcraft.edit/v1\ntitle: ${JSON.stringify(name)}\nlanguage: zh-CN\n---\n\n# 项目主旨\n\n用一句话写下这个项目最重要的命题。\n\n## 写作目标\n\n读者读完后应该理解、感受或采取什么行动？\n\n## 目标读者\n\n描述读者的背景、阅读场景和已有知识。\n\n## 范围与非目标\n\n明确这个项目写什么，以及暂时不写什么。\n\n## 内容结构\n\n列出 Part → Chapter → Section 的初步结构。\n\n## 语气与写作规则\n\n记录语气、术语、禁用表达和引用规范。\n\n## 关键实体与不变量\n\n记录人物、组织、概念、变量，以及不能被擅自改变的事实。\n\n## 时间与关系约束\n\n记录时间线、因果顺序和实体关系。\n\n## 来源与证据规则\n\n记录允许的来源、引用格式和证据门槛。\n\n## 开放问题\n\n记录仍待确认或需要验证的问题。\n`;
}

// A deliberately small front-matter reader. edit.md remains ordinary
// Markdown; this only reports top-level formatting/schema problems and never
// attempts to execute YAML tags or deserialize arbitrary objects.
function inspectEditFrontMatter(content) {
  if (typeof content !== 'string') fail('INVALID_CONTENT', 'edit.md 内容必须是文本');
  const source = content.replace(/^\uFEFF/, '');
  const lines = source.split(/\r?\n/);
  const diagnostics = [];
  if (lines[0] !== '---') {
    return {
      status: 'missing',
      data: {},
      diagnostics: [{ code: 'FRONT_MATTER_MISSING', severity: 'warning', line: 1, message: 'edit.md 缺少起始 Front Matter 分隔线 ---' }],
    };
  }
  const closing = lines.slice(1, 202).findIndex(line => line === '---');
  if (closing < 0) {
    return {
      status: 'invalid',
      data: {},
      diagnostics: [{ code: 'FRONT_MATTER_UNCLOSED', severity: 'error', line: 1, message: 'edit.md Front Matter 缺少结束分隔线 ---' }],
    };
  }
  const endLine = closing + 1;
  const data = {};
  const keyLines = {};
  for (let index = 1; index < endLine; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\s/.test(line)) {
      diagnostics.push({ code: 'FRONT_MATTER_NESTING_UNSUPPORTED', severity: 'warning', line: index + 1, message: '当前版本只校验顶层 Front Matter 字段' });
      continue;
    }
    const match = line.match(/^([A-Za-z][A-Za-z0-9_.-]*):(?:\s*(.*))?$/);
    if (!match) {
      diagnostics.push({ code: 'FRONT_MATTER_INVALID_LINE', severity: 'error', line: index + 1, message: 'Front Matter 字段应使用 key: value 格式' });
      continue;
    }
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      diagnostics.push({ code: 'FRONT_MATTER_DUPLICATE_KEY', severity: 'error', line: index + 1, message: `Front Matter 字段 ${key} 重复` });
      continue;
    }
    let value = (match[2] || '').trim();
    if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
      try { value = JSON.parse(value); } catch (_) {}
    } else if (/^'(?:[^']|'')*'$/.test(value)) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    data[key] = value;
    keyLines[key] = index + 1;
  }
  if (!Object.prototype.hasOwnProperty.call(data, 'schema')) {
    diagnostics.push({ code: 'EDIT_SCHEMA_MISSING', severity: 'warning', line: 1, message: 'Front Matter 缺少 schema: writcraft.edit/v1' });
  } else if (data.schema !== 'writcraft.edit/v1') {
    diagnostics.push({ code: 'EDIT_SCHEMA_UNSUPPORTED', severity: 'error', line: keyLines.schema || 1, message: 'edit.md schema 必须为 writcraft.edit/v1' });
  }
  const hasError = diagnostics.some(item => item.severity === 'error');
  return {
    status: hasError ? 'invalid' : diagnostics.length ? 'warning' : 'valid',
    data,
    bodyOffset: lines.slice(0, endLine + 1).join('\n').length + (endLine + 1 < lines.length ? 1 : 0),
    diagnostics,
  };
}

// Produce a reviewable repair candidate only. The caller must put the result
// through the normal ChangeSet confirmation path; this function never writes.
// Safe deterministic repairs preserve every existing field and body line.
function proposeEditFrontMatterRepair(content) {
  if (typeof content !== 'string') fail('INVALID_CONTENT', 'edit.md 内容必须是文本');
  const inspection = inspectEditFrontMatter(content);
  if (inspection.status === 'valid') {
    return { status: 'not_needed', content, diagnostics: [] };
  }
  const unsafe = new Set([
    'FRONT_MATTER_UNCLOSED',
    'FRONT_MATTER_INVALID_LINE',
    'FRONT_MATTER_DUPLICATE_KEY',
  ]);
  if (inspection.diagnostics.some(item => unsafe.has(item.code))) {
    fail('EDIT_PROMPT_MANUAL_REPAIR_REQUIRED', 'Front Matter 结构不完整，需先按诊断行手动修复后再生成迁移提案');
  }
  const repairable = inspection.status === 'missing' || inspection.diagnostics.some(item =>
    item.code === 'EDIT_SCHEMA_MISSING' || item.code === 'EDIT_SCHEMA_UNSUPPORTED'
  );
  if (!repairable) {
    return { status: 'not_needed', content, diagnostics: inspection.diagnostics };
  }

  const source = content.replace(/^\uFEFF/, '');
  let repaired;
  if (inspection.status === 'missing') {
    repaired = `---\nschema: writcraft.edit/v1\n---\n\n${source}`;
  } else {
    const lines = source.split(/\r?\n/);
    const closing = lines.slice(1, 202).findIndex(line => line === '---') + 1;
    const schemaIndex = lines.slice(1, closing).findIndex(line => /^schema:\s*/.test(line));
    if (schemaIndex >= 0) lines[schemaIndex + 1] = 'schema: writcraft.edit/v1';
    else lines.splice(1, 0, 'schema: writcraft.edit/v1');
    repaired = lines.join('\n');
  }
  const repairedInspection = inspectEditFrontMatter(repaired);
  if (repairedInspection.data.schema !== 'writcraft.edit/v1' || repairedInspection.diagnostics.some(item => item.severity === 'error')) {
    fail('EDIT_PROMPT_REPAIR_FAILED', '无法安全生成 Front Matter 修复提案');
  }
  return {
    status: 'ready',
    content: repaired,
    diagnostics: inspection.diagnostics,
    repairedFrontMatter: repairedInspection,
  };
}

function emptyWorkspace() {
  return {
    tabs: [EDIT_FILE],
    activePath: EDIT_FILE,
    files: { [EDIT_FILE]: { cursorOffset: 0, scrollTop: 0 } },
  };
}

function firstMarkdownPath(rootPath) {
  const paths = [];
  const collect = nodes => {
    for (const node of nodes || []) {
      if (node.type === 'file' && /\.(?:md|markdown)$/i.test(node.path || '')) paths.push(node.path);
      if (node.children) collect(node.children);
    }
  };
  collect(listTree(rootPath));
  paths.sort((a, b) => (a === EDIT_FILE ? -1 : b === EDIT_FILE ? 1 : a.localeCompare(b, 'zh-CN')));
  return paths[0] || null;
}

function defaultWorkspace(rootPath) {
  const initial = firstMarkdownPath(rootPath);
  if (!initial) fail('NOT_WRITCRAFT_PROJECT', '目录中没有可编辑的 Markdown 文件');
  return { tabs: [initial], activePath: initial, files: { [initial]: { cursorOffset: 0, scrollTop: 0 } } };
}

function assertWorkspaceNumber(value, label, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000 || (integer && !Number.isInteger(value))) {
    fail('INVALID_WORKSPACE', `${label}无效`);
  }
  return value;
}

function assertExistingPublicMarkdown(rootPath, relPath) {
  const publicPath = assertPublicMarkdownPath(relPath);
  const target = resolveInside(rootPath, publicPath);
  const stat = fs.lstatSync(target.absolute);
  if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '工作区不能引用符号链接');
  if (!stat.isFile()) fail('NOT_FILE', '工作区只能引用 Markdown 文件');
  return publicPath;
}

function normalizeWorkspace(rootPath, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    fail('INVALID_WORKSPACE', '工作区状态无效');
  }
  if (!Array.isArray(state.tabs) || state.tabs.length === 0 || state.tabs.length > MAX_WORKSPACE_TABS) {
    fail('INVALID_WORKSPACE', '工作区标签页无效');
  }

  const tabs = [];
  const seen = new Set();
  for (const relPath of state.tabs) {
    const normalized = assertExistingPublicMarkdown(rootPath, relPath);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      tabs.push(normalized);
    }
  }
  const activePath = assertExistingPublicMarkdown(rootPath, state.activePath);
  if (!seen.has(activePath)) fail('INVALID_WORKSPACE', '当前文件必须在已打开标签页中');

  if (!state.files || typeof state.files !== 'object' || Array.isArray(state.files)) {
    fail('INVALID_WORKSPACE', '工作区文件位置无效');
  }
  const files = {};
  for (const relPath of tabs) {
    const position = state.files[relPath] || {};
    files[relPath] = {
      cursorOffset: assertWorkspaceNumber(position.cursorOffset ?? 0, '光标位置', true),
      scrollTop: assertWorkspaceNumber(position.scrollTop ?? 0, '滚动位置'),
    };
  }
  return { tabs, activePath, files };
}

function workspaceTarget(rootPath, createMetadataDirectory) {
  const root = assertDirectory(rootPath, '项目目录');
  const metadataDirectory = path.join(root, META_DIR);
  if (!fs.existsSync(metadataDirectory)) {
    if (!createMetadataDirectory) return null;
    fs.mkdirSync(metadataDirectory, { mode: 0o700 });
  }
  const stat = fs.lstatSync(metadataDirectory);
  if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '项目内部目录不能是符号链接');
  if (!stat.isDirectory()) fail('NOT_DIRECTORY', '项目内部路径不是目录');
  return path.join(metadataDirectory, path.basename(WORKSPACE_FILE));
}

function saveWorkspace(rootPath, state) {
  const workspace = normalizeWorkspace(rootPath, state);
  const payload = `${JSON.stringify({
    schema: WORKSPACE_SCHEMA,
    schemaVersion: 1,
    ...workspace,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_WORKSPACE_BYTES) {
    fail('WORKSPACE_TOO_LARGE', '工作区状态超过大小限制');
  }
  atomicWriteAbsolute(workspaceTarget(rootPath, true), payload);
  return workspace;
}

function loadWorkspace(rootPath) {
  const fallback = defaultWorkspace(rootPath);
  try {
    const target = workspaceTarget(rootPath, false);
    if (!target || !fs.existsSync(target)) return fallback;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_WORKSPACE_BYTES) return fallback;
    const parsed = JSON.parse(readBoundedAbsolute(target));
    if (parsed.schema !== WORKSPACE_SCHEMA || parsed.schemaVersion !== 1) return fallback;
    return normalizeWorkspace(rootPath, parsed);
  } catch (_) {
    // Workspace state is disposable UI state. A corrupt or stale file must
    // never prevent the user's actual writing project from opening.
    return fallback;
  }
}

function saveRecentProject(storageDirectory, rootPath) {
  const storage = assertDirectory(storageDirectory, '应用数据目录');
  const root = assertDirectory(rootPath, '项目目录');
  const target = path.join(storage, RECENT_FILE);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    fail('SYMLINK_NOT_ALLOWED', '最近项目记录不能是符号链接');
  }
  atomicWriteAbsolute(target, `${JSON.stringify({
    schema: RECENT_SCHEMA,
    schemaVersion: 1,
    rootPath: root,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

function loadRecentProject(storageDirectory, options = {}) {
  try {
    const storage = assertDirectory(storageDirectory, '应用数据目录');
    const target = path.join(storage, RECENT_FILE);
    if (!fs.existsSync(target)) return null;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RECENT_BYTES) return null;
    const parsed = JSON.parse(readBoundedAbsolute(target));
    if (parsed.schema !== RECENT_SCHEMA || parsed.schemaVersion !== 1 || typeof parsed.rootPath !== 'string') {
      return null;
    }
    // A recent-project record is ambient startup state, unlike a directory the
    // user explicitly selected in the open dialog. Never auto-restore projects
    // under the OS temporary directory in production: test fixtures and stale
    // scratch projects must not become the user's active writing authority.
    const root = assertDirectory(parsed.rootPath, '最近项目目录');
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    if (options.allowEphemeral !== true && isWithin(temporaryRoot, root)) return null;

    // The caller must still pass this canonical path through openProject before
    // assigning currentProject; this check only excludes ambient temp state.
    return root;
  } catch (_) {
    return null;
  }
}

function createProjectAt(parentPath, name) {
  const parent = assertDirectory(parentPath, '父目录');
  const cleanName = validateProjectName(name);
  const root = path.join(parent, cleanName);
  if (!isWithin(parent, root) || fs.existsSync(root)) {
    fail('PROJECT_EXISTS', '同名项目已经存在');
  }

  fs.mkdirSync(root, { mode: 0o700 });
  try {
    fs.mkdirSync(path.join(root, META_DIR), { mode: 0o700 });
    atomicWriteAbsolute(path.join(root, EDIT_FILE), makeEditTemplate(cleanName));
    atomicWriteAbsolute(path.join(root, META_FILE), `${JSON.stringify({
      schema: PROJECT_SCHEMA,
      schemaVersion: 1,
      projectId: crypto.randomUUID(),
      name: cleanName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    saveWorkspace(root, emptyWorkspace());
  } catch (error) {
    // The root was created exclusively by this call and contains no user data.
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
  return projectDescriptor(root);
}

function openProject(rootPath) {
  const root = assertDirectory(rootPath, '项目目录');
  const editPath = path.join(root, EDIT_FILE);
  if (!fs.existsSync(editPath)) {
    // A normal writing folder is a valid workspace even before it adopts
    // WritCraft metadata. The UI will offer an explicit edit.md creation step.
    if (!firstMarkdownPath(root)) fail('NOT_WRITCRAFT_PROJECT', '目录中没有可编辑的 Markdown 文件');
    return projectDescriptor(root);
  }
  if (fs.lstatSync(editPath).isSymbolicLink()) {
    fail('SYMLINK_NOT_ALLOWED', 'edit.md 不能是符号链接');
  }
  if (!fs.lstatSync(editPath).isFile()) {
    fail('NOT_WRITCRAFT_PROJECT', '项目根目录的 edit.md 不是文件');
  }
  readInternalFile(root, EDIT_FILE);
  return projectDescriptor(root);
}

function createEditPrompt(rootPath) {
  const root = assertDirectory(rootPath, '项目目录');
  const descriptor = projectDescriptor(root);
  const file = createMarkdownFile(root, EDIT_FILE, makeEditTemplate(descriptor.name));
  return { ...file, frontMatter: inspectEditFrontMatter(makeEditTemplate(descriptor.name)) };
}

function openProjectForRecovery(rootPath) {
  const root = assertDirectory(rootPath, '项目目录');
  let recognized = false;
  for (const relPath of [META_FILE, WORKSPACE_FILE]) {
    const absolute = path.join(root, relPath);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '项目内部恢复标记不能是符号链接');
    if (!stat.isFile()) continue;
    try {
      const parsed = JSON.parse(readBoundedAbsolute(absolute));
      if (relPath === META_FILE && parsed.schema === PROJECT_SCHEMA) recognized = true;
      if (relPath === WORKSPACE_FILE && parsed.schema === WORKSPACE_SCHEMA) recognized = true;
    } catch (_) {}
  }
  if (!recognized) fail('NOT_WRITCRAFT_PROJECT', '目录缺少可验证的 WritCraft 项目标记');
  return projectDescriptor(root);
}

function listTree(rootPath) {
  const root = assertDirectory(rootPath, '项目目录');
  let count = 0;

  function visit(directory, relativeDirectory, depth) {
    if (depth > MAX_TREE_DEPTH) fail('TREE_TOO_DEEP', '项目目录层级过深');
    const directoryStat = fs.lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      fail('SYMLINK_NOT_ALLOWED', '项目目录树不能经过符号链接');
    }
    const canonical = fs.realpathSync(directory);
    if (!isWithin(root, canonical)) fail('PATH_TRAVERSAL', '项目目录树已越出项目根目录');
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'));
    const nodes = [];
    for (const entry of entries) {
      // Internal metadata, VCS state and accidental secret files are not part
      // of the author-facing project tree.
      if (entry.name.startsWith('.')) continue;
      count += 1;
      if (count > MAX_TREE_ENTRIES) fail('TREE_TOO_LARGE', '项目文件数量超过限制');
      const rel = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        nodes.push({ name: entry.name, path: rel, type: 'symlink', blocked: true });
      } else if (entry.isDirectory()) {
        nodes.push({ name: entry.name, path: rel, type: 'directory', children: visit(path.join(directory, entry.name), rel, depth + 1) });
      } else if (entry.isFile()) {
        nodes.push({ name: entry.name, path: rel, type: 'file', size: fs.statSync(path.join(directory, entry.name)).size });
      }
    }
    return nodes;
  }

  return visit(root, '', 0);
}

function readFile(rootPath, relPath) {
  const publicPath = assertPublicMarkdownPath(relPath);
  const target = resolveInside(rootPath, publicPath);
  return readBoundedAbsolute(target.absolute);
}

function contentRevision(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function inspectMigrationFile(rootPath, relPath) {
  const root = assertDirectory(rootPath, '项目目录');
  const absolute = path.join(root, relPath);
  if (!fs.existsSync(absolute)) return null;
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', `${relPath} 不能是符号链接`);
  if (!stat.isFile()) fail('NOT_FILE', `${relPath} 不是普通文件`);
  const content = readBoundedAbsolute(absolute);
  return {
    path: relPath,
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    revision: contentRevision(content),
  };
}

function previewLegacyEditMigration(rootPath) {
  const source = inspectMigrationFile(rootPath, LEGACY_EDIT_FILE);
  const target = inspectMigrationFile(rootPath, EDIT_FILE);
  if (source && target) {
    return {
      status: 'conflict',
      canMigrate: false,
      source,
      target,
      message: 'editor.md 与 edit.md 同时存在，不会合并或覆盖',
    };
  }
  if (source) {
    return {
      status: 'ready',
      canMigrate: true,
      source,
      targetPath: EDIT_FILE,
      confirmationRevision: source.revision,
    };
  }
  if (target) {
    return { status: 'not_needed', canMigrate: false, target };
  }
  return {
    status: 'missing',
    canMigrate: false,
    sourcePath: LEGACY_EDIT_FILE,
    targetPath: EDIT_FILE,
  };
}

function migrateLegacyEditFile(rootPath, confirmation) {
  if (!confirmation || confirmation.confirmed !== true) {
    fail('CONFIRMATION_REQUIRED', '迁移 editor.md 需要用户明确确认');
  }
  const expectedRevision = confirmation.expectedRevision;
  if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
    fail('INVALID_REVISION', '迁移预览版本无效');
  }

  const root = assertDirectory(rootPath, '项目目录');
  const source = inspectMigrationFile(root, LEGACY_EDIT_FILE);
  const target = inspectMigrationFile(root, EDIT_FILE);

  // A repeated confirmation after a completed migration is harmless, but an
  // unrelated edit.md appearing after preview must never be mistaken for it.
  if (!source && target) {
    if (target.revision !== expectedRevision) {
      fail('MIGRATION_CONFLICT', 'edit.md 已存在且与迁移预览不同');
    }
    return { status: 'already_migrated', file: target };
  }
  if (!source && !target) fail('NOT_FOUND', '未找到 editor.md');
  if (source && target) fail('MIGRATION_CONFLICT', 'editor.md 与 edit.md 同时存在，绝不覆盖');
  if (source.revision !== expectedRevision) {
    fail('FILE_CONFLICT', 'editor.md 在预览后已被修改，请重新预览');
  }

  const sourceAbsolute = path.join(root, LEGACY_EDIT_FILE);
  const targetAbsolute = path.join(root, EDIT_FILE);
  try {
    // linkSync creates the destination exclusively: unlike renameSync on
    // POSIX, it cannot replace a target that appears between preview and
    // confirmation. unlink then gives the user-visible semantics of rename.
    fs.linkSync(sourceAbsolute, targetAbsolute);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      fail('MIGRATION_CONFLICT', 'edit.md 已存在，绝不覆盖');
    }
    throw error;
  }

  const linkedStat = fs.lstatSync(targetAbsolute);
  const currentSourceStat = fs.lstatSync(sourceAbsolute);
  const sameLinkedFile = linkedStat.dev === currentSourceStat.dev && linkedStat.ino === currentSourceStat.ino;
  if (!sameLinkedFile) {
    // An external actor replaced one of the paths after the exclusive link.
    // Preserve both names: removing either one could delete unrelated work.
    fail('MIGRATION_CONFLICT', '迁移期间文件被外部替换，两个文件均已保留');
  }
  const linkedContent = readBoundedAbsolute(targetAbsolute);
  if (contentRevision(linkedContent) !== expectedRevision) {
    // Both paths still identify the same inode, so removing only our newly
    // created target link is safe and leaves the changed editor.md intact.
    fs.unlinkSync(targetAbsolute);
    syncDirectory(root);
    fail('FILE_CONFLICT', 'editor.md 在确认迁移时发生变更，请重新预览');
  }

  try {
    const fd = fs.openSync(targetAbsolute, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(root);
    fs.unlinkSync(sourceAbsolute);
    syncDirectory(root);
  } catch (error) {
    const wrapped = new ProjectServiceError(
      'MIGRATION_INCOMPLETE',
      '迁移未能完成清理；两个文件均保留，未覆盖任何内容'
    );
    wrapped.cause = error;
    throw wrapped;
  }
  return {
    status: 'migrated',
    file: { ...source, path: EDIT_FILE },
  };
}

// Pure preview helper for the renderer's separate localStorage migration UI.
// The caller still has to request an exclusive create through Main, so this
// naming plan is never treated as permission to overwrite a disk file.
function planLegacyDraftImport(content, requestedPath = 'chapters/imported-draft.md', occupiedPaths = []) {
  assertContent(content);
  const requested = assertPublicMarkdownPath(requestedPath);
  if (!Array.isArray(occupiedPaths)) fail('INVALID_PATH_LIST', '已有文件列表无效');
  const occupied = new Set(occupiedPaths.map(assertPublicMarkdownPath));
  const extension = path.posix.extname(requested);
  const stem = requested.slice(0, -extension.length);
  let targetPath = requested;
  for (let suffix = 2; occupied.has(targetPath); suffix += 1) {
    if (suffix > 10000) fail('TOO_MANY_CONFLICTS', '无法生成不冲突的导入文件名');
    targetPath = `${stem}-${suffix}${extension}`;
  }
  return {
    requestedPath: requested,
    targetPath,
    renamed: targetPath !== requested,
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    revision: contentRevision(content),
  };
}

function readFileWithRevision(rootPath, relPath) {
  const content = readFile(rootPath, relPath);
  const result = { content, revision: contentRevision(content) };
  if (assertPublicMarkdownPath(relPath) === EDIT_FILE) result.frontMatter = inspectEditFrontMatter(content);
  return result;
}

function conditionalWriteRevision(absolute, message) {
  try {
    if (!fs.existsSync(absolute)) fail('FILE_CONFLICT', message);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '不能覆盖符号链接文件');
    if (!stat.isFile()) fail('FILE_CONFLICT', message);
    return contentRevision(readBoundedAbsolute(absolute));
  } catch (error) {
    if (error instanceof ProjectServiceError) throw error;
    if (error && ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) fail('FILE_CONFLICT', message);
    throw error;
  }
}

function atomicWriteFile(rootPath, relPath, content, expectedRevision, options = {}) {
  const publicPath = assertPublicMarkdownPath(relPath);
  const target = resolveInside(rootPath, publicPath, { allowMissingLeaf: true });
  const parentStat = fs.statSync(path.dirname(target.absolute));
  if (!parentStat.isDirectory()) fail('NOT_DIRECTORY', '上级路径不是文件夹');
  if (fs.existsSync(target.absolute) && !fs.lstatSync(target.absolute).isFile()) {
    fail('NOT_FILE', '目标不是普通文件');
  }
  if (expectedRevision !== undefined && expectedRevision !== null) {
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      fail('INVALID_REVISION', '文件版本标识无效');
    }
    if (conditionalWriteRevision(target.absolute, '文件已被删除或替换，请重新载入后再保存') !== expectedRevision) {
      fail('FILE_CONFLICT', '文件已在其他位置被修改，请重新载入后再保存');
    }
  }
  atomicWriteAbsolute(target.absolute, content, {
    beforeRename: () => {
      if (typeof options.beforeSecondRevisionCheck === 'function') options.beforeSecondRevisionCheck();
      if (expectedRevision !== undefined && expectedRevision !== null) {
        // Re-resolve the path and re-read the authoritative bytes immediately
        // before rename. This closes the preparation-window race where another
        // editor changes the file after the first revision check.
        let checked;
        try { checked = resolveInside(target.root, target.relative); }
        catch (error) {
          if (error instanceof ProjectServiceError && error.code === 'SYMLINK_NOT_ALLOWED') throw error;
          fail('FILE_CONFLICT', '文件在保存准备期间被删除或替换，本次保存未覆盖磁盘');
        }
        if (conditionalWriteRevision(checked.absolute, '文件在保存准备期间被删除或替换，本次保存未覆盖磁盘') !== expectedRevision) {
          fail('FILE_CONFLICT', '文件在保存准备期间被其他位置修改，本次保存未覆盖磁盘');
        }
      }
    },
  });
  const result = {
    path: target.relative,
    bytes: Buffer.byteLength(content, 'utf8'),
    revision: contentRevision(content),
  };
  if (target.relative === EDIT_FILE) result.frontMatter = inspectEditFrontMatter(content);
  return result;
}

function overwriteConflictedFile(rootPath, relPath, content, observedRevision) {
  if (assertExpectedRevision(observedRevision) === null) {
    fail('CONFIRMATION_REQUIRED', '显式覆盖必须绑定用户看到的磁盘版本');
  }
  return atomicWriteFile(rootPath, relPath, content, observedRevision);
}

function ensureRecoveryDirectory(rootPath, create = true) {
  const root = assertDirectory(rootPath, '项目目录');
  let cursor = root;
  for (const part of [META_DIR, 'recovery']) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) {
      if (!create) return null;
      fs.mkdirSync(cursor, { mode: 0o700 });
    }
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '项目恢复目录不能是符号链接');
    if (!stat.isDirectory()) fail('NOT_DIRECTORY', '项目恢复路径不是文件夹');
  }
  return cursor;
}

function recoveryTarget(rootPath, relPath, create = true) {
  const safePath = assertPublicMarkdownPath(relPath);
  const directory = ensureRecoveryDirectory(rootPath, create);
  if (!directory) return { safePath, directory: null, target: null };
  const target = path.join(directory, `${crypto.createHash('sha256').update(safePath).digest('hex')}.json`);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) fail('UNSAFE_RECOVERY_PATH', '恢复稿必须是普通文件');
  }
  return { safePath, directory, target };
}

function parseRecoveryFile(target, expectedPath) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES) fail('RECOVERY_CORRUPT', '恢复稿文件无效或过大');
  let parsed;
  try { parsed = JSON.parse(readBoundedAbsolute(target)); } catch (_) { fail('RECOVERY_CORRUPT', '恢复稿内容损坏'); }
  if (!parsed || parsed.schema !== RECOVERY_SCHEMA || parsed.schemaVersion !== 1 ||
      parsed.path !== expectedPath || typeof parsed.content !== 'string' ||
      typeof parsed.savedAt !== 'string' || Number.isNaN(Date.parse(parsed.savedAt))) {
    fail('RECOVERY_CORRUPT', '恢复稿结构无效');
  }
  if (parsed.baseRevision !== null && !/^[a-f0-9]{64}$/.test(parsed.baseRevision || '')) fail('RECOVERY_CORRUPT', '恢复稿版本无效');
  return parsed;
}

function listRecoveries(rootPath) {
  const directory = ensureRecoveryDirectory(rootPath, false);
  if (!directory) return [];
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name));
  if (entries.length > MAX_RECOVERY_ENTRIES) fail('RECOVERY_LIMIT_EXCEEDED', '恢复稿数量超过安全上限');
  let total = 0;
  const output = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fail('UNSAFE_RECOVERY_PATH', '恢复稿不能是符号链接');
    total += stat.size;
    if (total > MAX_RECOVERY_TOTAL_BYTES) fail('RECOVERY_LIMIT_EXCEEDED', '恢复稿总量超过安全上限');
    const parsed = parseRecoveryFile(target, parsedPathFromRecoveryFilename(rootPath, target));
    output.push({ path: parsed.path, baseRevision: parsed.baseRevision, savedAt: parsed.savedAt, bytes: Buffer.byteLength(parsed.content, 'utf8') });
  }
  return output.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.path.localeCompare(b.path));
}

function parsedPathFromRecoveryFilename(rootPath, target) {
  // The path is stored inside the bounded JSON, but must match its filename.
  let parsed;
  try { parsed = JSON.parse(readBoundedAbsolute(target)); } catch (_) { fail('RECOVERY_CORRUPT', '恢复稿内容损坏'); }
  const safePath = assertPublicMarkdownPath(parsed && parsed.path);
  const expectedName = `${crypto.createHash('sha256').update(safePath).digest('hex')}.json`;
  if (path.basename(target) !== expectedName) fail('RECOVERY_CORRUPT', '恢复稿路径指纹不一致');
  return safePath;
}

function writeRecovery(rootPath, relPath, content, baseRevision = null) {
  const bytes = Buffer.byteLength(typeof content === 'string' ? content : '', 'utf8');
  if (typeof content !== 'string') fail('INVALID_CONTENT', '恢复稿必须是文本');
  if (bytes > MAX_RECOVERY_CONTENT_BYTES) fail('RECOVERY_TOO_LARGE', '单份恢复稿超过 4 MiB 上限');
  if (baseRevision !== null) assertExpectedRevision(baseRevision);
  const { safePath, directory, target } = recoveryTarget(rootPath, relPath, true);
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name));
  const exists = fs.existsSync(target);
  if (!exists && files.length >= MAX_RECOVERY_ENTRIES) fail('RECOVERY_LIMIT_EXCEEDED', '恢复稿数量已达 100 条上限');
  const payload = `${JSON.stringify({
    schema: RECOVERY_SCHEMA,
    schemaVersion: 1,
    path: safePath,
    baseRevision,
    content,
    savedAt: new Date().toISOString(),
  })}\n`;
  const currentBytes = exists ? fs.statSync(target).size : 0;
  const total = files.reduce((sum, entry) => sum + fs.statSync(path.join(directory, entry.name)).size, 0);
  if (total - currentBytes + Buffer.byteLength(payload, 'utf8') > MAX_RECOVERY_TOTAL_BYTES) {
    fail('RECOVERY_LIMIT_EXCEEDED', '恢复稿总量超过 20 MiB 上限');
  }
  atomicWriteAbsolute(target, payload);
  return { path: safePath, baseRevision, savedAt: JSON.parse(payload).savedAt, bytes };
}

function readRecovery(rootPath, relPath) {
  const { safePath, target } = recoveryTarget(rootPath, relPath, false);
  if (!target || !fs.existsSync(target)) return null;
  return parseRecoveryFile(target, safePath);
}

function clearRecovery(rootPath, relPath) {
  const { target, directory } = recoveryTarget(rootPath, relPath, false);
  if (!target || !fs.existsSync(target)) return { cleared: false };
  fs.unlinkSync(target);
  syncDirectory(directory);
  return { cleared: true };
}

function createMarkdownFile(rootPath, relPath, content = '') {
  assertContent(content);
  const normalized = assertPublicMarkdownPath(relPath);
  const parts = normalized.split('/');
  const target = resolveInside(rootPath, normalized, {
    allowMissingLeaf: true,
    allowMissingParents: true,
  });
  if (fs.existsSync(target.absolute)) fail('FILE_EXISTS', '文件已经存在');

  // Create one directory at a time and re-check after creation; a pre-existing
  // symlink is rejected by resolveInside before this loop.
  let cursor = target.root;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '项目路径不能经过符号链接');
    if (!stat.isDirectory()) fail('NOT_DIRECTORY', '上级路径不是文件夹');
  }

  const fd = fs.openSync(target.absolute, 'wx', 0o600);
  try {
    if (content) fs.writeFileSync(fd, content, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(target.absolute));
  return {
    path: target.relative,
    bytes: Buffer.byteLength(content, 'utf8'),
    revision: contentRevision(content),
  };
}

function assertExpectedRevision(expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null) return null;
  if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
    fail('INVALID_REVISION', '文件版本标识无效');
  }
  return expectedRevision;
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function assertOrdinaryFile(absolute, message = '目标不是普通文件') {
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '不能操作符号链接文件');
  if (!stat.isFile()) fail('NOT_FILE', message);
  return stat;
}

// Move one already-existing file without POSIX rename overwrite semantics.
// The destination hard link is created exclusively, then both names and the
// content revision are rechecked before the source name is removed. Because
// both paths are inside one project this remains an atomic, same-filesystem
// operation. If any post-link check fails, only the link created here is
// removed and the original name is preserved.
function moveFileExclusively(rootPath, sourceRelPath, targetRelPath, expectedRevision, options = {}) {
  const root = assertDirectory(rootPath, '项目目录');
  const source = resolveInside(root, sourceRelPath);
  const target = resolveInside(root, targetRelPath, { allowMissingLeaf: true });
  if (source.relative === target.relative) fail('SAME_PATH', '源文件与目标文件相同');
  if (fs.existsSync(target.absolute)) fail('FILE_EXISTS', '目标文件已经存在，不会覆盖');

  const sourceStat = assertOrdinaryFile(source.absolute, '源路径不是普通文件');
  const sourceParent = path.dirname(source.absolute);
  const targetParent = path.dirname(target.absolute);
  const sourceParentStat = fs.lstatSync(sourceParent);
  const targetParentStat = fs.lstatSync(targetParent);
  if (sourceParentStat.isSymbolicLink() || targetParentStat.isSymbolicLink()) {
    fail('SYMLINK_NOT_ALLOWED', '文件上级目录不能是符号链接');
  }
  if (!sourceParentStat.isDirectory() || !targetParentStat.isDirectory()) {
    fail('NOT_DIRECTORY', '目标上级路径不是文件夹');
  }

  const expected = assertExpectedRevision(expectedRevision);
  const beforeContent = readBoundedAbsolute(source.absolute);
  const beforeRevision = contentRevision(beforeContent);
  if (expected && beforeRevision !== expected) {
    fail('FILE_CONFLICT', '文件在操作前已发生变化，请刷新后重试');
  }

  let linked = false;
  try {
    fs.linkSync(source.absolute, target.absolute);
    linked = true;
  } catch (error) {
    if (error && error.code === 'EEXIST') fail('FILE_EXISTS', '目标文件已经存在，不会覆盖');
    throw error;
  }

  try {
    const targetStat = assertOrdinaryFile(target.absolute);
    const currentSourceStat = assertOrdinaryFile(source.absolute, '源文件在操作期间被替换');
    const currentSourceParentStat = fs.lstatSync(sourceParent);
    const currentTargetParentStat = fs.lstatSync(targetParent);
    if (!sameFileIdentity(sourceStat, targetStat) || !sameFileIdentity(targetStat, currentSourceStat) ||
        !sameFileIdentity(sourceParentStat, currentSourceParentStat) ||
        !sameFileIdentity(targetParentStat, currentTargetParentStat)) {
      fail('FILE_CONFLICT', '文件或目录在操作期间发生变化，未删除原文件');
    }
    const afterRevision = contentRevision(readBoundedAbsolute(target.absolute));
    if (afterRevision !== beforeRevision) {
      fail('FILE_CONFLICT', '文件在操作期间发生变化，未删除原文件');
    }
    if (typeof options.beforeUnlink === 'function') options.beforeUnlink({
      root,
      source,
      target,
      revision: beforeRevision,
      bytes: Buffer.byteLength(beforeContent, 'utf8'),
    });
    fs.unlinkSync(source.absolute);
    linked = false;
    syncDirectory(sourceParent);
    if (targetParent !== sourceParent) syncDirectory(targetParent);
    return {
      fromPath: source.relative,
      path: target.relative,
      bytes: Buffer.byteLength(beforeContent, 'utf8'),
      revision: beforeRevision,
    };
  } catch (error) {
    if (linked) {
      try {
        const targetStat = fs.lstatSync(target.absolute);
        if (sameFileIdentity(sourceStat, targetStat)) {
          fs.unlinkSync(target.absolute);
          syncDirectory(targetParent);
        }
      } catch (_) {}
    }
    throw error;
  }
}

function moveMarkdownFile(rootPath, sourceRelPath, targetRelPath, expectedRevision) {
  const source = assertPublicMarkdownPath(sourceRelPath);
  const target = assertPublicMarkdownPath(targetRelPath);
  if (source === EDIT_FILE || target === EDIT_FILE) {
    fail('EDIT_FILE_PROTECTED', 'edit.md 是项目级 Prompt，不能重命名或移动');
  }
  return moveFileExclusively(rootPath, source, target, expectedRevision);
}

function ensureTrashDirectory(rootPath) {
  const root = assertDirectory(rootPath, '项目目录');
  let cursor = root;
  for (const part of [META_DIR, 'trash']) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '项目回收区不能是符号链接');
    if (!stat.isDirectory()) fail('NOT_DIRECTORY', '项目回收区路径不是文件夹');
  }
  return { root, directory: cursor, manifest: path.join(cursor, 'manifest.json') };
}

function readTrashManifest(rootPath, create = false) {
  const target = create ? ensureTrashDirectory(rootPath) : (() => {
    const root = assertDirectory(rootPath, '项目目录');
    const directory = path.join(root, TRASH_DIR);
    return { root, directory, manifest: path.join(root, TRASH_MANIFEST_FILE) };
  })();
  if (!fs.existsSync(target.manifest)) return { schema: TRASH_SCHEMA, schemaVersion: 1, entries: [] };
  const stat = fs.lstatSync(target.manifest);
  if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '回收区清单不能是符号链接');
  if (!stat.isFile()) fail('NOT_FILE', '回收区清单不是普通文件');
  let parsed;
  try { parsed = JSON.parse(readBoundedAbsolute(target.manifest)); }
  catch (_) { fail('TRASH_MANIFEST_INVALID', '回收区清单损坏；未移动任何文件'); }
  if (parsed.schema !== TRASH_SCHEMA || parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
    fail('TRASH_MANIFEST_INVALID', '回收区清单格式无效；未移动任何文件');
  }
  if (parsed.entries.length > MAX_TRASH_ENTRIES) fail('TRASH_FULL', '项目回收区记录已达上限');
  return parsed;
}

function writeTrashManifest(rootPath, manifest) {
  const target = ensureTrashDirectory(rootPath);
  if (manifest.entries.length > MAX_TRASH_ENTRIES) fail('TRASH_FULL', '项目回收区记录已达上限');
  atomicWriteAbsolute(target.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
}

function trashMarkdownFile(rootPath, relPath, expectedRevision) {
  const source = assertPublicMarkdownPath(relPath);
  if (source === EDIT_FILE) fail('EDIT_FILE_PROTECTED', 'edit.md 是项目级 Prompt，不能移到回收区');
  const manifest = readTrashManifest(rootPath, true);
  if (manifest.entries.length >= MAX_TRASH_ENTRIES) fail('TRASH_FULL', '项目回收区记录已达上限');
  const id = crypto.randomUUID();
  const extension = path.posix.extname(source).toLowerCase();
  const internalPath = `${TRASH_DIR.split(path.sep).join('/')}/${id}${extension}`;
  let entry;
  let moved;
  try {
    moved = moveFileExclusively(rootPath, source, internalPath, expectedRevision, {
      beforeUnlink(details) {
        entry = {
          id,
          originalPath: source,
          trashPath: internalPath,
          deletedAt: new Date().toISOString(),
          revision: details.revision,
          bytes: details.bytes,
        };
      },
    });
    writeTrashManifest(rootPath, { ...manifest, entries: [...manifest.entries, entry] });
  } catch (error) {
    if (moved) {
      try { moveFileExclusively(rootPath, internalPath, source, moved.revision); }
      catch (rollbackError) {
        const wrapped = new ProjectServiceError(
          'TRASH_INCOMPLETE',
          '回收区清单写入失败，恢复原路径也失败；文件仍保存在项目回收区'
        );
        wrapped.cause = rollbackError;
        throw wrapped;
      }
    }
    throw error;
  }
  return { ...moved, trashed: true, trashEntry: entry };
}

function listTrash(rootPath) {
  return readTrashManifest(rootPath, false).entries.map(entry => ({ ...entry }));
}

function restoreTrashedMarkdown(rootPath, entryId) {
  if (typeof entryId !== 'string' || !/^[0-9a-f-]{36}$/i.test(entryId)) {
    fail('INVALID_TRASH_ENTRY', '回收区记录无效');
  }
  const manifest = readTrashManifest(rootPath, false);
  const index = manifest.entries.findIndex(entry => entry && entry.id === entryId);
  if (index < 0) fail('TRASH_ENTRY_NOT_FOUND', '未找到回收区记录');
  const entry = manifest.entries[index];
  const original = assertPublicMarkdownPath(entry.originalPath);
  if (original === EDIT_FILE) fail('EDIT_FILE_PROTECTED', '回收区记录不能替换 edit.md');
  const expectedTrashPath = `${TRASH_DIR.split(path.sep).join('/')}/${entryId}${path.posix.extname(original).toLowerCase()}`;
  if (entry.trashPath !== expectedTrashPath) fail('TRASH_MANIFEST_INVALID', '回收区记录路径无效');
  const restored = moveFileExclusively(rootPath, entry.trashPath, original, entry.revision);
  try {
    writeTrashManifest(rootPath, {
      ...manifest,
      entries: manifest.entries.filter((_, entryIndex) => entryIndex !== index),
    });
  } catch (error) {
    try { moveFileExclusively(rootPath, original, entry.trashPath, entry.revision); }
    catch (rollbackError) {
      const wrapped = new ProjectServiceError(
        'RESTORE_INCOMPLETE',
        '文件已恢复，但回收区清单更新失败；请勿继续操作并备份文件'
      );
      wrapped.cause = rollbackError;
      throw wrapped;
    }
    throw error;
  }
  return { ...restored, restored: true, trashEntryId: entryId };
}

module.exports = {
  EDIT_FILE,
  LEGACY_EDIT_FILE,
  META_DIR,
  META_FILE,
  WORKSPACE_FILE,
  WORKSPACE_SCHEMA,
  TRASH_DIR,
  TRASH_MANIFEST_FILE,
  TRASH_SCHEMA,
  RECOVERY_DIR,
  RECOVERY_SCHEMA,
  RECENT_FILE,
  MAX_FILE_BYTES,
  MAX_RECOVERY_ENTRIES,
  MAX_RECOVERY_CONTENT_BYTES,
  MAX_RECOVERY_TOTAL_BYTES,
  ProjectServiceError,
  createProjectAt,
  openProject,
  openProjectForRecovery,
  createEditPrompt,
  inspectEditFrontMatter,
  proposeEditFrontMatterRepair,
  listTree,
  readFile,
  readFileWithRevision,
  atomicWriteFile,
  overwriteConflictedFile,
  createMarkdownFile,
  moveMarkdownFile,
  trashMarkdownFile,
  listTrash,
  restoreTrashedMarkdown,
  previewLegacyEditMigration,
  migrateLegacyEditFile,
  planLegacyDraftImport,
  loadWorkspace,
  saveWorkspace,
  loadRecentProject,
  saveRecentProject,
  writeRecovery,
  readRecovery,
  listRecoveries,
  clearRecovery,
  projectDescriptor,
};
