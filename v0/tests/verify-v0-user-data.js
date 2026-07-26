'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userDataService = require('../src/main/user-data-service');
const apiKeyConfigService = require('../src/main/api-key-config-service');
const projectService = require('../src/main/project-service');

const VALID_OLD_KEY = `sk-cp-${'Old1_'.repeat(16)}`;
const VALID_NEW_KEY = `sk-api-${'New2_'.repeat(16)}`;
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

function makeScratch() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-user-data-')));
}

function makeApp(appData) {
  const calls = [];
  return {
    calls,
    getPath(name) {
      calls.push(['getPath', name]);
      assert.strictEqual(name, 'appData', 'userData must not be read before it is fixed');
      return appData;
    },
    setPath(name, value) {
      calls.push(['setPath', name, value]);
    },
  };
}

function makeLegacy(appData, name) {
  const directory = path.join(appData, name);
  fs.mkdirSync(directory, { mode: 0o700 });
  return directory;
}

function setMtime(target, milliseconds) {
  const date = new Date(milliseconds);
  fs.utimesSync(target, date, date);
}

console.log('\nStable Electron userData migration verification');

test('fixes userData at appData/WritCraft with a private directory before any userData read', () => {
  const scratch = makeScratch();
  try {
    const appData = path.join(scratch, 'Application Support');
    fs.mkdirSync(appData);
    const app = makeApp(appData);
    const result = userDataService.configureUserData(app);
    const expected = path.join(appData, 'WritCraft');
    assert.strictEqual(result.stableDirectory, expected);
    assert.deepStrictEqual(app.calls, [
      ['getPath', 'appData'],
      ['setPath', 'userData', expected],
    ]);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(expected).mode & 0o077, 0);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('selects the newest independently validated legacy file and migrates only the allowlist', () => {
  const scratch = makeScratch();
  try {
    const appData = path.join(scratch, 'Application Support');
    fs.mkdirSync(appData);
    const dev = makeLegacy(appData, 'writ-craft');
    const packaged = makeLegacy(appData, '笔触 · WritCraft');
    const oldProject = projectService.createProjectAt(scratch, '旧项目');
    const newProject = projectService.createProjectAt(scratch, '新项目');

    apiKeyConfigService.saveUserKey(dev, VALID_OLD_KEY);
    apiKeyConfigService.saveUserKey(packaged, VALID_NEW_KEY);
    projectService.saveRecentProject(dev, oldProject.rootPath);
    projectService.saveRecentProject(packaged, newProject.rootPath);
    fs.writeFileSync(path.join(packaged, 'Local State'), 'must-not-migrate');
    const now = Date.now();
    setMtime(path.join(dev, apiKeyConfigService.CONFIG_FILE), now - 10_000);
    setMtime(path.join(packaged, apiKeyConfigService.CONFIG_FILE), now);
    setMtime(path.join(dev, projectService.RECENT_FILE), now);
    setMtime(path.join(packaged, projectService.RECENT_FILE), now - 10_000);

    const result = userDataService.configureUserData(makeApp(appData), { allowEphemeralRecent: true });
    assert.deepStrictEqual(result.migration, {
      attempted: true,
      aiConfigMigrated: true,
      recentProjectMigrated: true,
    });
    assert.strictEqual(apiKeyConfigService.loadUserKey(result.stableDirectory).apiKey, VALID_NEW_KEY);
    assert.strictEqual(
      projectService.loadRecentProject(result.stableDirectory, { allowEphemeral: true }),
      oldProject.rootPath
    );
    assert.strictEqual(fs.existsSync(path.join(result.stableDirectory, 'Local State')), false);
    const names = fs.readdirSync(result.stableDirectory);
    assert.deepStrictEqual(names.filter(name => name.includes('.tmp')), []);
    assert.deepStrictEqual(names.sort(), [
      userDataService.MIGRATION_MARKER,
      apiKeyConfigService.CONFIG_FILE,
      projectService.RECENT_FILE,
    ].sort());
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('skips corrupt, insecure and symlinked newer candidates instead of copying them', () => {
  const scratch = makeScratch();
  try {
    const appData = path.join(scratch, 'Application Support');
    fs.mkdirSync(appData);
    const dev = makeLegacy(appData, 'writ-craft');
    const packaged = makeLegacy(appData, '笔触 · WritCraft');
    const project = projectService.createProjectAt(scratch, '安全项目');
    apiKeyConfigService.saveUserKey(dev, VALID_OLD_KEY);
    projectService.saveRecentProject(dev, project.rootPath);

    fs.writeFileSync(path.join(packaged, apiKeyConfigService.CONFIG_FILE), JSON.stringify({
      schema: apiKeyConfigService.CONFIG_SCHEMA,
      schemaVersion: 1,
      apiKey: VALID_NEW_KEY,
      keyType: 'FULL',
    }), { mode: 0o600 });
    fs.chmodSync(path.join(packaged, apiKeyConfigService.CONFIG_FILE), 0o644);
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(dev, projectService.RECENT_FILE), path.join(packaged, projectService.RECENT_FILE));
    } else {
      fs.writeFileSync(path.join(packaged, projectService.RECENT_FILE), '{broken', { mode: 0o600 });
    }
    const now = Date.now();
    setMtime(path.join(packaged, apiKeyConfigService.CONFIG_FILE), now);

    const result = userDataService.configureUserData(makeApp(appData), { allowEphemeralRecent: true });
    assert.strictEqual(apiKeyConfigService.loadUserKey(result.stableDirectory).apiKey, VALID_OLD_KEY);
    assert.strictEqual(
      projectService.loadRecentProject(result.stableDirectory, { allowEphemeral: true }),
      project.rootPath
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('never overwrites stable files, even when they are older or malformed', () => {
  const scratch = makeScratch();
  try {
    const appData = path.join(scratch, 'Application Support');
    fs.mkdirSync(appData);
    const stable = path.join(appData, 'WritCraft');
    fs.mkdirSync(stable, { mode: 0o700 });
    const legacy = makeLegacy(appData, 'writ-craft');
    apiKeyConfigService.saveUserKey(legacy, VALID_NEW_KEY);
    const stableBytes = '{intentionally-existing-but-invalid}\n';
    fs.writeFileSync(path.join(stable, apiKeyConfigService.CONFIG_FILE), stableBytes, { mode: 0o600 });

    const result = userDataService.configureUserData(makeApp(appData));
    assert.strictEqual(result.migration.aiConfigMigrated, false);
    assert.strictEqual(fs.readFileSync(path.join(stable, apiKeyConfigService.CONFIG_FILE), 'utf8'), stableBytes);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('one-time marker prevents a cleared key from being silently re-imported later', () => {
  const scratch = makeScratch();
  try {
    const appData = path.join(scratch, 'Application Support');
    fs.mkdirSync(appData);
    const legacy = makeLegacy(appData, 'writ-craft');
    apiKeyConfigService.saveUserKey(legacy, VALID_OLD_KEY);
    const first = userDataService.configureUserData(makeApp(appData));
    apiKeyConfigService.clearUserKey(first.stableDirectory);

    const second = userDataService.configureUserData(makeApp(appData));
    assert.deepStrictEqual(second.migration, {
      attempted: false,
      aiConfigMigrated: false,
      recentProjectMigrated: false,
    });
    assert.strictEqual(apiKeyConfigService.loadUserKey(second.stableDirectory), null);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('fails closed for symlinked stable storage', () => {
  if (process.platform === 'win32') return;
  const scratch = makeScratch();
  try {
    const appData = path.join(scratch, 'Application Support');
    const outside = path.join(scratch, 'outside');
    fs.mkdirSync(appData);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(appData, 'WritCraft'));
    assert.throws(
      () => userDataService.configureUserData(makeApp(appData)),
      error => error && error.code === 'UNSAFE_STABLE_DIRECTORY'
    );
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('Main configures the stable path before any userData consumer and keeps E2E isolated', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const configureAt = main.indexOf('userDataService.configureUserData(app');
  const firstUserDataRead = main.indexOf("app.getPath('userData')");
  assert(configureAt > 0);
  assert(firstUserDataRead > configureAt);
  assert(main.includes("argument.startsWith('--user-data-dir=')"));
  assert(main.includes("!app.isPackaged && process.env.WRITCRAFT_E2E_AI_FIXTURE === '1'"));
  assert(main.includes("!app.isPackaged && process.env.WRITCRAFT_E2E_USER_DATA === '1'"));
});

test('isolated test profile is explicitly set without consulting appData or running migration', () => {
  const scratch = makeScratch();
  try {
    const isolated = path.join(scratch, 'isolated');
    fs.mkdirSync(isolated);
    const calls = [];
    const app = {
      getPath() { throw new Error('must not read appData'); },
      setPath(name, value) { calls.push([name, value]); },
    };
    const result = userDataService.configureUserData(app, { isolatedTestDirectory: isolated });
    assert.strictEqual(result.isolated, true);
    assert.strictEqual(result.migration, null);
    assert.deepStrictEqual(calls, [['userData', isolated]]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

console.log(`\n${passed}/8 stable userData checks passed.\n`);
