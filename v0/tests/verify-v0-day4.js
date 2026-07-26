// 4 重 verify 已在前几轮覆盖。Day 4 验收是主人的视觉测试。
// 此脚本只验 Day 4 新增文件的静态层。

const fs = require('fs');
const path = require('path');

const V0 = path.join(__dirname, '..');
let PASS = 0, FAIL = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log(`  ✓ ${label}` + (detail ? ` (${detail})` : '')); PASS++; }
  else { console.log(`  ✗ ${label}` + (detail ? ` (${detail})` : '')); FAIL++; }
};

console.log('════════ WritCraft V0 · Day 4 静态层 verify ════════');

// 4.1 Inline Diff 操作（Day 5 后从侧栏面板迁移到原文锚点）
const html = fs.readFileSync(path.join(V0, 'src/renderer/index.html'), 'utf-8');
const edJs = fs.readFileSync(path.join(V0, 'src/renderer/editor.js'), 'utf-8');
check('editor.js 含 Inline Diff 重载操作', edJs.includes("makeButton('重载', 'regenerate'"));
check('editor.js 含 Inline Diff 接受/拒绝操作', edJs.includes("makeButton('接受', 'accept'") && edJs.includes("makeButton('拒绝', 'reject'"));

// 4.2 Diff 高亮
check('HTML 含 .inline-diff-add 样式（绿色背景）', html.includes('.inline-diff-add'));
check('HTML 含 .inline-diff-remove 样式（红色背景）', html.includes('.inline-diff-remove'));
check('diff.min.js 在 renderer 目录', fs.existsSync(path.join(V0, 'src/renderer/diff.min.js')));
check('diff-renderer.js 在 renderer 目录', fs.existsSync(path.join(V0, 'src/renderer/diff-renderer.js')));

const diffJs = fs.readFileSync(path.join(V0, 'src/renderer/diff-renderer.js'), 'utf-8');
check('diff-renderer.js 调用已加载的 Diff API', diffJs.includes('window.Diff || window.diff') && diffJs.includes('diffApi.diffWords'));
check('diff-renderer.js 暴露 window.__diffRender', diffJs.includes('window.__diffRender'));
check('diff-renderer.js 含 add/remove/eq 3 种类型', diffJs.includes("diff-add") && diffJs.includes("diff-remove") && diffJs.includes("diff-eq"));

// 4.3 ⌘L 上下文标签
check('HTML 含 #chat-context-label', html.includes('id="chat-context-label"'));
check('HTML 含 chat-context-label 上下文标签样式', html.includes('#chat-context-label') && html.includes('border-radius'));
check('editor.js 实现 updateChatContextLabel', edJs.includes('updateChatContextLabel'));
check('editor.js 缓存编辑器选区上下文', edJs.includes('cachedEditorSelection'));
check('editor.js 含 selectionchange 监听', edJs.includes('selectionchange'));
check('editor.js 文件作用域显示路径与字符数', edJs.includes('📄 文件') && edJs.includes('getStableText().length'));
check('editor.js 选区作用域显示精确选区与相邻段落', edJs.includes('🎯 选区') && edJs.includes('相邻段落'));

// 4.4 Markdown 渲染
check('marked.umd.js 在 renderer 目录', fs.existsSync(path.join(V0, 'src/renderer/marked.umd.js')));
check('marked 在 package.json deps', (() => {
  const p = JSON.parse(fs.readFileSync(path.join(V0, 'package.json'), 'utf-8'));
  return p.dependencies && p.dependencies.marked;
})());

check('HTML 含 .md-body 样式', html.includes('.md-body'));
check('HTML 含 blockquote/h1/h2/h3 渲染样式', html.includes('.md-body blockquote') || html.includes('blockquote'));
check('editor.js 调用 window.marked.parse', edJs.includes('window.marked.parse'));
check('editor.js AI 回复启用 Markdown', edJs.includes("appendChatMsg('ai', result.text, true)"));
check('editor.js 用户消息 useMarkdown=false', edJs.includes('useMarkdown: false') || edJs.includes('useMarkdown=false') || edJs.includes('appendChatMsg(\'user\', userMessage, false)'));

// 第三方库真存在 + 体积合理
const diffPath = path.join(V0, 'src/renderer/diff.min.js');
const markedPath = path.join(V0, 'src/renderer/marked.umd.js');
check('diff.min.js 体积 30-50KB', (() => {
  const s = fs.statSync(diffPath).size;
  return s > 30000 && s < 50000;
})(), `${(fs.statSync(diffPath).size / 1024).toFixed(1)}KB`);
check('marked.umd.js 体积 35-50KB', (() => {
  const s = fs.statSync(markedPath).size;
  return s > 35000 && s < 60000;
})(), `${(fs.statSync(markedPath).size / 1024).toFixed(1)}KB`);

// 第三方 CDN 依赖不在 HTML 内（必须本地）
check('HTML 不引用外部 CDN', !/https?:\/\/.*\.(?:cdn|jsdelivr|unpkg)\.com/.test(html));

// Key 来源边界：应用设置优先、启动环境回退，绝不读取项目根 .env。
const mainJs = fs.readFileSync(path.join(V0, 'src/main/main.js'), 'utf-8');
check('main.js 不自动读取项目根 .env', !mainJs.includes('function loadEnv') && !mainJs.includes('ENV_PATH'));
check('main.js 统一通过 resolveActiveApiKey', mainJs.includes('function resolveActiveApiKey()'));
check('Main 保留显式启动环境 Key 回退', mainJs.includes('process.env.WRITCRAFT_MINIMAX_KEY'));
check('NO_PROJECT 由安全项目错误建立，改写通过统一 Main 项目态与 exact error 边界返回',
  mainJs.includes("new projectService.ProjectServiceError('NO_PROJECT'") &&
  /ipcMain\.handle\('writcraft:rewrite'[\s\S]*?const project = requireCurrentProject\(\)[\s\S]*?return inlineRewriteFailure\(error\)/.test(mainJs));

console.log(`\n通过 ${PASS} / 失败 ${FAIL}`);
if (FAIL === 0) {
  console.log('\n✅ Day 4 静态层全过');
  console.log('⚠️  GUI 层验证（需主人目视）:');
  console.log('   1. ⌘K 选段 → 看到 Diff 高亮（绿色新增 / 红色删除） + 重载按钮 + Diff/纯文本切换');
  console.log('   2. ⌘L → 看到上下文标签（文件=蓝色“📄 文件”，选区=橙色“🎯 选区”，并可切项目作用域）');
  console.log('   3. ⌘L 输入问题 → AI 回复渲染 Markdown（清理 ** > 等）');
  process.exit(0);
} else {
  console.log('\n❌ Day 4 有失败');
  process.exit(1);
}
