# WritCraft v0.1.2 Developer Preview

> 候选发布说明。0.1.2 尚未发布；公开安装仍会获得 0.1.1，直到 npm 与 GitHub prerelease 完成并验证。

## 这一版解决什么

0.1.2 把真实作者反馈中最容易迷路的一段流程收拢成一条连续任务：从写作导航建议出发，一次点击即可在正文中看到红删绿增 Diff；作者可以接受、拒绝、继续调整，并在写入后安全撤销。

同时加入：

- 空项目结构方案比较、逐项编辑与章节骨架创建；
- 已有长文的证据锚定写作导航；
- 15 秒可取消、60 秒硬终态和明确处理阶段；
- Main-owned `rangeId`、revision、owner 与 ChangeSet 权限边界；
- 项目恢复、输入焦点、滚动、审阅按钮与错误文案等真实作者反馈修复。

## 不变的安全承诺

- AI 只生成预览，接受前不修改项目文件；
- `edit.md`、`references/` 与 `sources/` 的既有只读边界不变；
- 每次正文写入必须经过可见 Diff 与作者确认；
- 保留冲突阻止、History、项目隔离与 Safe Undo；
- 不自动付费重试，不把 Preview 标记为 npm `latest`。

## 安装

发布并完成公网验证后：

```bash
npx writ-craft@preview
```

需要 macOS 12+、Node.js 22.12+，以及 npm 10 或 11。此版本仍是专有评估许可证下的 Developer Preview，不是已签名、公证的独立 App。
