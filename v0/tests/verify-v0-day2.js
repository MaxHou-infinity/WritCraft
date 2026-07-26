#!/usr/bin/env node
// WritCraft V0 · Day 2 verify (修订版: contenteditable, 非 TipTap)
// Day 2 验收: 加载 → 输入 → 字符计数实时更新
// TipTap 完整集成留到 Day 3 + Vite 引入后

const fs = require('fs');
const path = require('path');

const V0 = path.join(__dirname, '..');
let PASS = 0, FAIL = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ✓ ${label}` + (detail ? ` (${detail})` : '')); PASS++; }
  else { console.log(`  ✗ ${label}` + (detail ? ` (${detail})` : '')); FAIL++; }
};

console.log('════════ WritCraft V0 · Day 2 verify (修订) ════════');

// 文件层
check('src/renderer/editor.js 存在', fs.existsSync(path.join(V0, 'src/renderer/editor.js')));
check('src/renderer/index.html 存在', fs.existsSync(path.join(V0, 'src/renderer/index.html')));

const html = fs.readFileSync(path.join(V0, 'src/renderer/index.html'), 'utf-8');
check('HTML 含 #editor', html.includes('id="editor"'));
check('HTML 含 #char-count', html.includes('id="char-count"'));
check('HTML 含 #tip-tap-status', html.includes('id="tip-tap-status"'));
check('HTML 引用 editor.js', html.includes('src="editor.js"') || html.includes("src='editor.js'"));
check('HTML 主题色使用 CSS 变量', html.includes('--theme:'));
check('HTML 纸张背景使用 CSS 变量', html.includes('--paper:'));
check('HTML 标题 笔触 · WritCraft', html.includes('笔触 · WritCraft'));

// editor.js: contenteditable + 字符计数
const js = fs.readFileSync(path.join(V0, 'src/renderer/editor.js'), 'utf-8');
check('editor.js 设 contentEditable=true', js.includes("contentEditable = 'true'") || js.includes('.contentEditable = "true"'));
check('editor.js 监听 input 事件', js.includes("addEventListener('input'"));
check('editor.js 字符计数', js.includes('innerText') && js.includes('length'));
check('editor.js focus()', js.includes('.focus()'));
check('editor.js 错误处理', js.includes('setStatus'));
check('editor.js 含 placeholder', js.includes('data-placeholder') || js.includes('placeholder'));

const mainJs = fs.readFileSync(path.join(V0, 'src/main/main.js'), 'utf-8');
check('main.js: contextIsolation', mainJs.includes('contextIsolation: true'));
check('main.js: nodeIntegration:false', mainJs.includes('nodeIntegration: false'));
check('main.js: DevTools 仅开发模式开启', mainJs.includes("process.argv.includes('--dev')") && mainJs.includes('openDevTools'));
check('main.js: console-message 监听', mainJs.includes('console-message'));
check('main.js: did-fail-load 监听', mainJs.includes('did-fail-load'));

const preloadJs = fs.readFileSync(path.join(V0, 'src/main/preload.js'), 'utf-8');
check('preload.js: contextBridge.exposeInMainWorld', preloadJs.includes('contextBridge.exposeInMainWorld'));
check('preload.js: detectKeyType (Day 1)', preloadJs.includes('detectKeyType'));

// Electron 资产
check('Electron.app 安装', fs.existsSync(path.join(V0, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')));
check('@tiptap/core 安装（Day 3 备用）', fs.existsSync(path.join(V0, 'node_modules/@tiptap/core/package.json')));
check('@tiptap/starter-kit 安装（Day 3 备用）', fs.existsSync(path.join(V0, 'node_modules/@tiptap/starter-kit/package.json')));

console.log(`\n通过 ${PASS} / 失败 ${FAIL}`);
if (FAIL === 0) {
  console.log('\n✅ Day 2 文件层全过（contenteditable 方案 · TipTap Day 3 接）');
  console.log('⚠️  GUI 层验证（需主人目视）:');
  console.log('   1. 弹窗里可点击编辑区');
  console.log('   2. 输入字符计数实时更新');
  console.log('   3. DevTools 自动打开（main.js 已配）');
  process.exit(0);
} else {
  console.log('\n❌ Day 2 有失败');
  process.exit(1);
}
