#!/usr/bin/env node
// WritCraft V0 · Day 1 verify 脚本
// 诚实说明：这只是文件存在性 + JSON 合法性 + 关键字符串包含的 verify
// **没有真跑 `npm install` 或 `electron`**（那需要主人手跑）

const fs = require('fs');
const path = require('path');

const V0 = path.join(__dirname, '..');
let PASS = 0, FAIL = 0;
const check = (label, condition) => {
  if (condition) { console.log(`  ✓ ${label}`); PASS++; }
  else { console.log(`  ✗ ${label}`); FAIL++; }
};

console.log('════════ WritCraft V0 · Day 1 文件存在性 verify ════════');
check('package.json 存在', fs.existsSync(path.join(V0, 'package.json')));
check('src/main/main.js 存在', fs.existsSync(path.join(V0, 'src/main/main.js')));
check('src/main/preload.js 存在', fs.existsSync(path.join(V0, 'src/main/preload.js')));  // 反陷阱 11 改进
check('src/renderer/index.html 存在', fs.existsSync(path.join(V0, 'src/renderer/index.html')));
check('Main Key 配置服务存在', fs.existsSync(path.join(V0, 'src/main/api-key-config-service.js')));

console.log('\n════════ 内容合法性 verify ════════');
const pkg = JSON.parse(fs.readFileSync(path.join(V0, 'package.json'), 'utf-8'));
check("package.json 是合法 JSON", !!pkg.name);
check("name = writ-craft", pkg.name === "writ-craft");
check("main = src/main/main.js", pkg.main === "src/main/main.js");
check("包含 electron 运行时依赖", !!pkg.dependencies.electron);
check("不发布未使用的 TipTap 运行依赖",
  !pkg.dependencies["@tiptap/core"] && !pkg.dependencies["@tiptap/starter-kit"]);
check("package.json 有 overrides 锁 markdown-it", !!pkg.overrides && !!pkg.overrides["markdown-it"]);  // 反陷阱 13 改进：方括号语法避免 hyphen 解析

const mainJs = fs.readFileSync(path.join(V0, 'src/main/main.js'), 'utf-8');
check('main.js 含 sk-api- 检测', mainJs.includes("'sk-api-'"));
check('main.js 含 sk-cp- 检测', mainJs.includes("'sk-cp-'"));
check('main.js 含 SK-api- 大小写兼容', mainJs.includes("'SK-api-'"));
check('main.js 含 SK-cp- 大小写兼容', mainJs.includes("'SK-cp-'"));
check('main.js 标题 笔触 · WritCraft', mainJs.includes('笔触 · WritCraft'));

const preloadJs = fs.readFileSync(path.join(V0, 'src/main/preload.js'), 'utf-8');
check('preload.js 引用 contextBridge', preloadJs.includes('contextBridge'));
check('preload.js 引用 ipcRenderer', preloadJs.includes('ipcRenderer'));
check('preload.js 暴露 writCraft API', preloadJs.includes('writCraft'));
check('preload.js 含 Key 类型检测 API', preloadJs.includes('detectKeyType'));

const html = fs.readFileSync(path.join(V0, 'src/renderer/index.html'), 'utf-8');
check('HTML 标题 笔触 · WritCraft', html.includes('笔触 · WritCraft'));
check('HTML 以 CSS 变量定义克制主题色', html.includes('--theme:'));
check('HTML 以 CSS 变量定义纸张背景', html.includes('--paper:'));
check('HTML 保留 V0 产品阶段标识', html.includes('V0'));

console.log(`\n通过 ${PASS} / 失败 ${FAIL}`);
if (FAIL === 0) {
  console.log('\n✅ Day 1 verify 全过 — 文件结构 + 内容合法性 + 心流规范 全部 OK');
  console.log('   Electron 作为 npm Developer Preview 的运行时依赖发布。');
  process.exit(0);
} else {
  console.log('\n❌ 有失败项需要修复');
  process.exit(1);
}
