#!/usr/bin/env node
'use strict';

// Stage E real-App cold-start gate. Fixture creation is outside the clock;
// every sample uses a new project directory, profile and Electron process.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const {
  launchElectron, stopElectron, waitForValue, skipReason, knownGuiFailure, boundedLog,
} = require('./verify-v0-electron-e2e');

const SAMPLE_COUNT = 5;
const CASES = Object.freeze([
  { markdownFiles: 50, budgetMs: 1500 },
  { markdownFiles: 300, budgetMs: 3000 },
]);

function fixture(parentPath, markdownFiles, sample) {
  const project = projectService.createProjectAt(parentPath, `Perf-${markdownFiles}-${sample}`);
  const chapters = path.join(project.rootPath, 'chapters');
  fs.mkdirSync(chapters, { recursive: true });
  for (let index = 1; index < markdownFiles; index += 1) {
    const serial = String(index).padStart(3, '0');
    fs.writeFileSync(path.join(chapters, `chapter-${serial}.md`), [
      `# 第 ${serial} 章`,
      `## 目标 ${serial}`,
      `这是固定性能样本 ${serial}，只包含本地确定性正文。`,
      '',
    ].join('\n'), 'utf8');
  }
  return project;
}

function report(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
  return { sorted, median, p95, max: sorted[sorted.length - 1] };
}

async function main() {
  const unavailable = skipReason();
  if (unavailable) throw new Error(`真实 Electron 不可用：${unavailable}`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-workspace-perf-'));
  try {
    for (const testCase of CASES) {
      const values = [];
      for (let sample = 1; sample <= SAMPLE_COUNT; sample += 1) {
        const sampleRoot = path.join(scratch, `${testCase.markdownFiles}-${sample}`);
        fs.mkdirSync(sampleRoot, { recursive: true });
        const project = fixture(sampleRoot, testCase.markdownFiles, sample);
        const profile = path.join(sampleRoot, 'profile');
        let app = null;
        const started = performance.now();
        try {
          app = await launchElectron(profile, project.rootPath);
          await waitForValue(app.client, `(() => {
            const project = window.__workspace?.state?.project;
            const editor = document.getElementById('editor');
            const tree = document.getElementById('project-tree');
            const home = document.querySelector('button[data-workspace-view="home"]');
            if (!project || !editor || !tree || !home || editor.getAttribute('contenteditable') !== 'true') return null;
            home.focus();
            return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
              resolve(document.activeElement === home && tree.querySelectorAll('.tree-file').length >= ${testCase.markdownFiles}
                ? true : null);
            })));
          })()`, `${testCase.markdownFiles}-file operable first frame`, 5000);
          values.push(performance.now() - started);
        } catch (error) {
          if (knownGuiFailure(error.processLog || '')) {
            throw new Error(`真实 Electron GUI 失败：${boundedLog(error.processLog)}`);
          }
          throw error;
        } finally {
          await stopElectron(app).catch(() => {});
        }
      }
      const stats = report(values);
      assert(stats.max <= testCase.budgetMs,
        `${testCase.markdownFiles} 文件冷启动 max ${stats.max.toFixed(1)}ms 超过 ${testCase.budgetMs}ms`);
      console.log(`${testCase.markdownFiles} files: ${stats.sorted.map(value => value.toFixed(1)).join(', ')} ms; ` +
        `median=${stats.median.toFixed(1)} p95=${stats.p95.toFixed(1)} max=${stats.max.toFixed(1)}`);
    }
    console.log('verify-v0-daily-workspace-performance: ok');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
