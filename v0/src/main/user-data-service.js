'use strict';

// Electron derives userData from the development package name and the packaged
// product name. Those names are intentionally different in WritCraft, so using
// Electron's default would split private app state across two profiles. This
// service establishes one stable profile and performs a one-time, allowlisted
// migration of the two small files that existed before the stable path.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const apiKeyConfigService = require('./api-key-config-service');
const projectService = require('./project-service');

const STABLE_DIRECTORY_NAME = 'WritCraft';
const LEGACY_DIRECTORY_NAMES = Object.freeze(['writ-craft', '笔触 · WritCraft']);
const MIGRATION_MARKER = '.legacy-user-data-migration-v1.json';
const RECENT_SCHEMA = 'writcraft.recent/v1';

class UserDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UserDataError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new UserDataError(code, message);
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function syncDirectory(directory) {
  try {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (_) {}
}

function assertCanonicalDirectory(directory, label) {
  if (typeof directory !== 'string' || !directory) fail('INVALID_DIRECTORY', `${label}无效`);
  const absolute = path.resolve(directory);
  const stat = lstatOrNull(absolute);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('UNSAFE_DIRECTORY', `${label}必须是普通目录`);
  }
  if (fs.realpathSync(absolute) !== absolute) fail('UNSAFE_DIRECTORY', `${label}路径不可信`);
  return absolute;
}

function ensurePrivateDirectory(directory, options = {}) {
  const absolute = path.resolve(directory);
  const existing = lstatOrNull(absolute);
  if (!existing) {
    fs.mkdirSync(absolute, { mode: 0o700 });
    syncDirectory(path.dirname(absolute));
  } else if (existing.isSymbolicLink() || !existing.isDirectory()) {
    fail('UNSAFE_STABLE_DIRECTORY', 'WritCraft 应用数据路径不是普通目录');
  }
  const canonical = fs.realpathSync(absolute);
  if (canonical !== absolute && options.allowCanonicalAlias !== true) {
    fail('UNSAFE_STABLE_DIRECTORY', 'WritCraft 应用数据路径不可信');
  }
  if (process.platform !== 'win32') fs.chmodSync(absolute, 0o700);
  return canonical;
}

// Create a complete file at one new name without ever replacing an existing
// entry. linkSync is the atomic no-clobber publication step on the same volume.
function atomicCreate(target, content) {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.user-data-migration.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(temporary, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    fs.unlinkSync(temporary);
    syncDirectory(directory);
    return true;
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(temporary); } catch (_) {}
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
}

function safeLegacyDirectories(appDataDirectory) {
  const directories = [];
  for (const name of LEGACY_DIRECTORY_NAMES) {
    const candidate = path.join(appDataDirectory, name);
    const stat = lstatOrNull(candidate);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    try {
      if (fs.realpathSync(candidate) !== candidate) continue;
      directories.push({ name, directory: candidate });
    } catch (_) {}
  }
  return directories;
}

function newestValidCandidate(directories, fileName, validate) {
  const valid = [];
  for (const candidate of directories) {
    const target = path.join(candidate.directory, fileName);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const value = validate(candidate.directory);
      if (value === null || value === undefined) continue;
      valid.push({ name: candidate.name, mtimeMs: stat.mtimeMs, value });
    } catch (_) {
      // Legacy profile content is untrusted ambient state. A bad candidate is
      // ignored without logging its contents or path.
    }
  }
  valid.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  return valid[0] || null;
}

function migrationAlreadyAttempted(stableDirectory) {
  // Any entry at the marker name (including a symlink or malformed file) makes
  // migration fail closed. Never replace ambient filesystem state.
  return lstatOrNull(path.join(stableDirectory, MIGRATION_MARKER)) !== null;
}

function migrateLegacyUserData(appDataDirectory, stableDirectory, options = {}) {
  const summary = { attempted: false, aiConfigMigrated: false, recentProjectMigrated: false };
  if (migrationAlreadyAttempted(stableDirectory)) return summary;
  summary.attempted = true;

  const legacyDirectories = safeLegacyDirectories(appDataDirectory);
  const aiTarget = path.join(stableDirectory, apiKeyConfigService.CONFIG_FILE);
  if (lstatOrNull(aiTarget) === null) {
    const selected = newestValidCandidate(
      legacyDirectories,
      apiKeyConfigService.CONFIG_FILE,
      directory => apiKeyConfigService.loadUserKey(directory)
    );
    if (selected) {
      const payload = `${JSON.stringify({
        schema: apiKeyConfigService.CONFIG_SCHEMA,
        schemaVersion: 1,
        apiKey: selected.value.apiKey,
        keyType: selected.value.keyType,
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`;
      summary.aiConfigMigrated = atomicCreate(aiTarget, payload);
    }
  }

  const recentTarget = path.join(stableDirectory, projectService.RECENT_FILE);
  if (lstatOrNull(recentTarget) === null) {
    const selected = newestValidCandidate(
      legacyDirectories,
      projectService.RECENT_FILE,
      directory => projectService.loadRecentProject(directory, {
        allowEphemeral: options.allowEphemeralRecent === true,
      })
    );
    if (selected) {
      const payload = `${JSON.stringify({
        schema: RECENT_SCHEMA,
        schemaVersion: 1,
        rootPath: selected.value,
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`;
      summary.recentProjectMigrated = atomicCreate(recentTarget, payload);
    }
  }

  atomicCreate(path.join(stableDirectory, MIGRATION_MARKER), `${JSON.stringify({
    schema: 'writcraft.user-data-migration/v1',
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return summary;
}

function configureUserData(electronApp, options = {}) {
  if (!electronApp || typeof electronApp.getPath !== 'function' || typeof electronApp.setPath !== 'function') {
    fail('INVALID_ELECTRON_APP', 'Electron app 接口无效');
  }

  // The GUI E2E provides an explicit disposable profile. This exception is
  // Main-only and must never be enabled by a packaged build.
  if (typeof options.isolatedTestDirectory === 'string' && options.isolatedTestDirectory) {
    // macOS exposes its temporary directory through /var while realpath is
    // /private/var. This explicit test-only alias remains on the same directory
    // and must not weaken the production stable-profile check.
    const isolated = ensurePrivateDirectory(options.isolatedTestDirectory, { allowCanonicalAlias: true });
    electronApp.setPath('userData', isolated);
    return { stableDirectory: isolated, isolated: true, migration: null };
  }

  // appData is the only Electron path read before userData is fixed.
  const appDataDirectory = assertCanonicalDirectory(electronApp.getPath('appData'), '系统应用数据目录');
  const stableDirectory = ensurePrivateDirectory(path.join(appDataDirectory, STABLE_DIRECTORY_NAME));
  const migration = migrateLegacyUserData(appDataDirectory, stableDirectory, options);
  electronApp.setPath('userData', stableDirectory);
  return { stableDirectory, isolated: false, migration };
}

module.exports = {
  STABLE_DIRECTORY_NAME,
  LEGACY_DIRECTORY_NAMES,
  MIGRATION_MARKER,
  UserDataError,
  atomicCreate,
  migrateLegacyUserData,
  configureUserData,
};
