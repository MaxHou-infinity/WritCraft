#!/usr/bin/env node
// WritCraft V0 · Day 3 verify
// 静态层: IPC 暴露 + ⌘K/⌘L 监听 + UI 元素 + M3 真实验证

const fs = require('fs');
const path = require('path');

const V0 = path.join(__dirname, '..');
let PASS = 0, FAIL = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ✓ ${label}` + (detail ? ` (${detail})` : '')); PASS++; }
  else { console.log(`  ✗ ${label}` + (detail ? ` (${detail})` : '')); FAIL++; }
};

async function main() {
  console.log('════════ WritCraft V0 · Day 3 文件层 + API ════════');

  // 1. main.js 含 ⌘K / ⌘L IPC
  const mainJs = fs.readFileSync(path.join(V0, 'src/main/main.js'), 'utf-8');
  const textService = fs.readFileSync(path.join(V0, 'src/main/minimax-text-service.js'), 'utf-8');
  check('main.js: writcraft:rewrite IPC handler', mainJs.includes("'writcraft:rewrite'"));
  check('main.js: writcraft:chat IPC handler', mainJs.includes("'writcraft:chat'"));
  check('main.js: callLLM helper', mainJs.includes('async function callLLM'));
  check('main.js: M3 model default', mainJs.includes("'MiniMax-M3'"));
  check('Main 文本服务: Anthropic protocol header', textService.includes("'anthropic-version'"));
  check('Main 文本服务: text block 提取', textService.includes("block.type === 'text'"));
  check('main.js: 检查 writcraft:check-api（Day 2）', mainJs.includes("'writcraft:check-api'"));

  // 2. preload.js 暴露
  const preloadJs = fs.readFileSync(path.join(V0, 'src/main/preload.js'), 'utf-8');
  check('preload.js: rewrite 暴露', preloadJs.includes("rewrite:"));
  check('preload.js: chat 暴露', preloadJs.includes("chat:"));
  check('preload.js: checkApi 暴露', preloadJs.includes("checkApi:"));
  check('preload.js: detectKeyType (Day 1)', preloadJs.includes('detectKeyType'));

  // 3. editor.js 键盘监听 + UI 控制
  const editorJs = fs.readFileSync(path.join(V0, 'src/renderer/editor.js'), 'utf-8');
  check('editor.js: ⌘K 监听', editorJs.includes("e.key.toLowerCase() === 'k'"));
  check('editor.js: ⌘L 监听', editorJs.includes("e.key.toLowerCase() === 'l'"));
  check('editor.js: ESC 关闭', editorJs.includes("e.key === 'Escape'"));
  check('editor.js: getSelection 选中段', editorJs.includes('getSelection'));
  check('editor.js: doRewrite 调用 IPC', editorJs.includes('window.writCraft.rewrite'));
  check('editor.js: doChat 调用 IPC', editorJs.includes('window.writCraft.chat'));
  check('editor.js: 接受 / 拒绝按钮', editorJs.includes('REWRITE_ACCEPT') && editorJs.includes('REWRITE_REJECT'));

  // 4. index.html UI 元素
  const html = fs.readFileSync(path.join(V0, 'src/renderer/index.html'), 'utf-8');
  check('HTML: #rewrite-panel', html.includes('id="rewrite-panel"'));
  check('HTML: #rewrite-loading', html.includes('id="rewrite-loading"'));
  check('HTML: #rewrite-proposal', html.includes('id="rewrite-proposal"'));
  check('HTML: #rewrite-accept', html.includes('id="rewrite-accept"'));
  check('HTML: #rewrite-reject', html.includes('id="rewrite-reject"'));
  check('HTML: #chat-panel', html.includes('id="chat-panel"'));
  check('HTML: #chat-messages', html.includes('id="chat-messages"'));
  check('HTML: #chat-input', html.includes('id="chat-input"'));
  check('HTML: #chat-submit', html.includes('id="chat-submit"'));
  check('HTML: #chat-close', html.includes('id="chat-close"'));

  // 5. 真打 API — M3 改写（仿真 IPC 内容）
  console.log('\n════════ M3 真实验证（Day 3 端到端）══════');
  const apiKey = String(process.env.WRITCRAFT_MINIMAX_KEY || '').trim();
  if (!apiKey) {
    check('启动环境含 WRITCRAFT_MINIMAX_KEY', false, '请显式 export 后再运行真实 API 验证');
    process.exit(1);
  }
  check('启动环境含 WRITCRAFT_MINIMAX_KEY', true);
  const BASE = 'https://api.minimaxi.com/anthropic/v1';

  try {
    // 仿真 rewrite 调用
    const t0 = Date.now();
    const rewriteResp = await fetch(`${BASE}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'MiniMax-M3',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: '你是中文写作助手。把下面这段文字改写得更优雅、流畅、逻辑清晰。直接输出新段落，不要任何前缀说明、不要使用引号包裹、不要 Markdown 标记。\n\n原文：\n水电费是每个月都要交的。'
        }],
      }),
    });
    const dt1 = Date.now() - t0;
    check('POST /messages (rewrite) HTTP 200', rewriteResp.ok, `${rewriteResp.status} in ${dt1}ms`);
    if (rewriteResp.ok) {
      const data = await rewriteResp.json();
      const tb = (data.content || []).find(b => b.type === 'text');
      check('M3 返回 text block', !!tb);
      if (tb) check('改写结果非空', tb.text.length > 0, `前 30 字: "${tb.text.slice(0, 30)}"`);
    }

    // 仿真 chat 调用
    const t1 = Date.now();
    const chatResp = await fetch(`${BASE}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'MiniMax-M3',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: '你是中文写作助手，专门帮助用户规划、改进、润色文章。请用简洁、专业、温暖的语气回答。\n\n问题：我想写一篇短篇小说，主题是孤独。有什么建议？'
        }],
      }),
    });
    const dt2 = Date.now() - t1;
    check('POST /messages (chat) HTTP 200', chatResp.ok, `${chatResp.status} in ${dt2}ms`);
    if (chatResp.ok) {
      const data = await chatResp.json();
      const tb = (data.content || []).find(b => b.type === 'text');
      check('M3 chat 返回 text', !!tb);
      if (tb) check('chat 回复非空且有建议', tb.text.length > 20, `前 40 字: "${tb.text.slice(0, 40)}"`);
    }
  } catch (err) {
    check('API 调用无异常', false, err.message);
  }

  console.log(`\n通过 ${PASS} / 失败 ${FAIL}`);
  if (FAIL === 0) {
    console.log('\n✅ Day 3 静态层 + M3 端到端 全过');
    console.log('⚠️  GUI 层验证（需主人目视）：');
    console.log('   1. 选中一段文字 → ⌘K → 看到右上方 M3 改写面板');
    console.log('   2. 接受 / 拒绝按钮工作');
    console.log('   3. ⌘L 打开全局对话面板 → 输入 → M3 回答');
    process.exit(0);
  } else {
    console.log('\n❌ Day 3 有失败');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('verify crashed:', err);
  process.exit(2);
});
