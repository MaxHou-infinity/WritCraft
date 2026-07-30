# 笔触 · WritCraft npm Developer Preview

笔触是面向专业长文作者的 Cursor 式 AI 写作 IDE。当前 npm 版本是仅供
macOS 技术预览和作者验收使用的 V0，不是已签名、公证的普通用户安装包。

## 安装与启动

需要 macOS 12 或更高版本、Node.js 22.12 或更高版本，以及 npm 10 或
npm 11。npm 12 不读取当前预览版随包发布的依赖 shrinkwrap，因此会被
CLI 明确拒绝：

```bash
npx writ-craft@preview
```

安装后可先运行零网络检查：

```bash
npx writ-craft@preview --check
```

如需完全隔离既有配置、凭据和最近项目，可先创建仅当前用户可访问的目录：

```bash
mkdir -m 700 "$HOME/WritCraft-Preview-Profile"
npx writ-craft@preview --profile "$HOME/WritCraft-Preview-Profile"
```

首次真正启动时，Electron 可能从官方发布源下载对应的 macOS 运行时；
此步骤需要联网，之后会复用本机缓存。

项目内容保存在作者选择的本地目录中。MiniMax Key 只应通过应用设置保存，
不要写入项目、仓库、命令行参数或问题报告。`sk-cp-` 和 `sk-api-` 均可配置；
`image-01` 的实际权限由套餐权益、Credits 与每日额度决定。

## 预览边界

- 清单和 universal helpers 面向 macOS arm64/x64。当前公开 `@preview`
  仍是 0.1.1；未发布的 0.1.2 候选准备已重新用 fresh tarball 覆盖
  npm 10/arm64 与 npm 11/x64，各 2/2。该结果不是作者旅程或发布证据。
- `--profile` 必须位于当前用户 HOME 内，且路径祖先、目录权限和 macOS ACL 都通过双重校验；同一账户下已运行进程仍属于接受的本地信任边界。
- WritCraft 按 `WritCraft Proprietary Evaluation License 1.0` 提供，只允许
  个人或组织内部授权评估；禁止生产、商业交付、托管服务、转售和对外再分发。
- 内嵌的 jsdiff 与 Marked 遵循 `THIRD_PARTY_NOTICES.md` 中的原许可；
  Electron、pdfjs-dist 和其他 npm 依赖保留各自包内许可证与声明。
- 通过终端启动，不提供已签名的 `WritCraft.app`。
- 不保证适合非技术用户或生产分发。
- 发现问题时请先使用应用内的隐私安全诊断导出。
