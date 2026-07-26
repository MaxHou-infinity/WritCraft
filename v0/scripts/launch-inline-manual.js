#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const projectService = require('../src/main/project-service');
const longformFixture = require('../tests/fixtures/writcraft-longform-project');
const aiFixture = require('../tests/fixtures/electron-ai-provider');

const APP_ROOT = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-inline-manual-'));
const project = longformFixture.buildLongformProject({ parentPath: scratch, projectService });
const targetPath = 'chapters/07-inline-manual.md';

projectService.createMarkdownFile(project.rootPath, targetPath);
const targetContent = [
  '# Inline Rewrite 人工验收',
  aiFixture.REWRITE_BEFORE,
  aiFixture.REWRITE_TARGET,
  aiFixture.REWRITE_AFTER,
  aiFixture.REWRITE_FAR,
].join('\n\n');
projectService.atomicWriteFile(project.rootPath, targetPath, targetContent);

const edit = projectService.readFileWithRevision(project.rootPath, projectService.EDIT_FILE);
projectService.atomicWriteFile(
  project.rootPath,
  projectService.EDIT_FILE,
  `${edit.content.trimEnd()}\n\n${aiFixture.ONBOARDING_MARKER}\n\n${aiFixture.ONBOARDING_RERUN_MARKER}\n`,
  edit.revision
);

const profileRoot = path.join(scratch, 'profile');
const userData = path.join(profileRoot, 'chromium-user-data');
const home = path.join(profileRoot, 'home');
const xdg = path.join(profileRoot, 'xdg-config');
for (const directory of [userData, home, xdg]) fs.mkdirSync(directory, { recursive: true });
for (const directory of new Set([
  userData,
  path.join(home, 'Library', 'Application Support', 'WritCraft'),
  path.join(home, 'Library', 'Application Support', 'writ-craft'),
  path.join(xdg, 'WritCraft'),
  path.join(xdg, 'writ-craft'),
])) {
  fs.mkdirSync(directory, { recursive: true });
  projectService.saveRecentProject(directory, project.rootPath);
}

const electronPath = require('electron');
const child = spawn(electronPath, [
  APP_ROOT,
  `--user-data-dir=${userData}`,
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-sync',
  '--no-first-run',
  '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost',
], {
  cwd: APP_ROOT,
  env: {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    WRITCRAFT_MINIMAX_KEY: aiFixture.API_KEY,
    WRITCRAFT_E2E_AI_FIXTURE: '1',
    WRITCRAFT_E2E_USER_DATA: '1',
  },
  stdio: 'inherit',
});

console.log(`MANUAL_PROJECT=${project.rootPath}`);
console.log(`MANUAL_TARGET=${targetPath}`);
console.log('Close WritCraft to remove the isolated project and profile.');

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  fs.rmSync(scratch, { recursive: true, force: true });
}

child.once('exit', code => {
  cleanup();
  process.exitCode = code === 0 ? 0 : 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (child.exitCode === null) child.kill(signal);
    else cleanup();
  });
}
