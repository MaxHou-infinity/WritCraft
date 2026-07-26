# Windsurf 辅助调研

> 调研日期：2026-07-14 | 时效说明：产品信息基于 2024-2026 公开资料，定价已更新至 2026 年最新版本

---

## 1. 一句话定义

Windsurf 是 Codeium 于 2024 年 11 月发布的 AI 代码编辑器，基于 VS Code fork，主打"first agentic IDE"定位——以 Cascade 自主代理和 Flow 状态感知为核心，主打免费档慷慨程度和比 Cursor 更低的 Pro 定价。

---

## 2. 与 Cursor 的核心差异（3-5 个）

### 2.1 Cascade 代理 vs Composer 代理

Cascade（Cognition 的 SWE-1 模型驱动）采用**自主执行优先**模式：用户给出目标后，Cascade 自动规划路径、读写文件、执行终端命令，自主完成多步任务后再向用户报告。Cursor Composer 则更偏向**审查驱动**——每一步操作需要用户确认或可以逐步干预，对需要精细控制的开发者更友好。来源：[Descope](https://www.descope.com/blog/post/cursor-vs-windsurf)、[Augment](https://www.augmentcode.com/tools/cursor-vs-windsurf-codeium-feature-and-price-guide)

### 2.2 Flow 状态感知

Windsurf 引入"Flow"概念，AI 能感知编辑器的实时状态（光标位置、打开文件、终端输出），在用户工作流中断时主动接管或提供上下文相关的建议。Cursor 的 AI 感知依赖于用户手动 `@` 引用文件或 `@codebase` 范围搜索，没有等效的 Flow 主动感知机制。来源：[Tembo](https://www.tembo.io/blog/cursor-vs-windsurf)、[MindStudio](https://www.mindstudio.ai/blog/windsurf-vs-cursor-vs-claude-code)

### 2.3 免费档限制

| 档位 | Windsurf Free | Cursor Free |
|------|--------------|-------------|
| 每日配额 | 25 credits（含 Tab 补全 + Cascade Base 使用） | 有限额度，主要为补全 |
| Tab 补全 | 无限 | 有限 |
| Pro 价格 | $15/月（2024-2025）/ $20/月（2026） | $20/月 |

来源：[SaaS Price Pulse](https://www.saaspricepulse.com/blog/ai-coding-assistant-pricing-guide-2025)、[PE Collective](https://pecollective.com/tools/windsurf-pricing)

### 2.4 自研 SWE-1 模型

Windsurf 使用 Codeium 自研 SWE-1 系列模型（2024年推出），专门针对软件工程任务优化。SWE-1.5 达到接近 Claude 3.5 Sonnet 的编程水平，但速度快 13 倍。SWE-1.6 2025年发布，SWE-1.7 于 2026 年预览。Cursor 则不训练自己的基础模型，依赖第三方模型（Claude、GPT、Gemini 等）加上自己的 Composer 模型路由。来源：[Codeium Docs Models](https://docs.codeium.com/windsurf/models)

### 2.5 生态兼容性

Windsurf 提供 40+ IDE 插件（JetBrains、Vim、Xcode 等），可以通过插件形式接入非 VS Code 环境。Cursor 仅为 VS Code fork，生态局限于 VS Code 扩展体系。来源：[Verdent Guides](https://www.verdent.ai/guides/windsurf-vs-cursor-ai-ide-2026)

---

## 3. 定价

| 档位 | 价格 | 主要内容 |
|------|------|----------|
| Free | $0 | 每日 25 credits，Tab 补全、Cascade Base 访问 |
| Pro | $20/月（2026年更新，早期 $15） | 500 credits（2024-2025），每日/每周更多配额，Cascade 全功能 |
| Max | $200/月 | 更高配额 + 云端后台开发会话 |
| Teams | $40/user/月 | 团队管理、共享配置 |
| Enterprise | 定制 | ACUs 计费模式，私有部署 |

定价历史：2025 年 4 月前使用 credit 系统，500 credits/Pro；2026 年 3 月取消 credit，改用每日/每周配额模型。SWE-1.7 预览期免费至 2026 年 8 月 8 日。Flex credits 可灵活用于 User Prompt 或 Flow Action。

来源：[CloudZero](https://www.cloudzero.com/blog/windsurf-pricing)、[Codeium Blog](https://devin.ai/blog/pricing-windsurf)、[SaaS Price Pulse](https://www.saaspricepulse.com/blog/ai-coding-assistant-pricing-guide-2025)

---

## 4. 借鉴 WritCraft 的 3 个设计点

（注：WritCraft 为本项目自研 AI IDE 概念，以下设计点基于行业最佳实践提炼）

### 4.1 代理优先（Agentic-first）而非助手优先

Windsurf 最大的设计创新在于将 AI 代理（Cascade）置于 IDE 中心，而非作为侧边栏聊天工具存在。这与 Cursor 将 Composer 作为一种模式（而非默认体验）形成对比。WritCraft 可借鉴：默认交互模式即为代理模式，而非传统补全+聊天的分离设计。

### 4.2 可预测定价模型

Windsurf 的 SWE-1 模型采用固定 credit 消耗模式（可预测成本），相比 Cursor 的动态 credit 消耗更透明。这对需要控制成本的独立开发者和团队是重要吸引力。WritCraft 可借鉴：设计 credit 或步数配额时，优先考虑可预测性而非灵活性。

### 4.3 状态感知上下文（Flow 机制）

Flow 机制让 AI 不依赖用户手动引用，而是主动感知编辑器状态。这种"沉默的上下文感知"降低了用户认知负担。WritCraft 可借鉴：代理上下文收集应尽量自动化，减少用户的 `@` 显式引用负担。

---

## 5. 引用清单

| # | 来源 | URL | 时效 |
|---|------|-----|------|
| 1 | Codeium Docs - Cascade | https://docs.codeium.com/windsurf/cascade | 持续更新 |
| 2 | Codeium Docs - AI Models | https://docs.codeium.com/windsurf/models | 持续更新 |
| 3 | Devin AI Blog - Pricing | https://devin.ai/blog/pricing-windsurf | 2025年4月 |
| 4 | SaaS Price Pulse - Codeium Free Tier | https://www.saaspricepulse.com/blog/ai-coding-assistant-pricing-guide-2025 | 2025年 |
| 5 | CloudZero - Windsurf Pricing 2026 | https://www.cloudzero.com/blog/windsurf-pricing | 2026年 |
| 6 | PE Collective - Windsurf Review | https://pecollective.com/tools/windsurf | 2026年 |
| 7 | Augment Code - Cursor vs Windsurf | https://www.augmentcode.com/tools/cursor-vs-windsurf-codeium-feature-and-price-guide | 2025年 |
| 8 | Descope - Cursor vs Windsurf | https://www.descope.com/blog/post/cursor-vs-windsurf | 2024-2025年 |
| 9 | Verdent Guides - Windsurf vs Cursor 2026 | https://www.verdent.ai/guides/windsurf-vs-cursor-ai-ide-2026 | 2026年 |
| 10 | MindStudio - Windsurf vs Cursor vs Claude Code | https://www.mindstudio.ai/blog/windsurf-vs-cursor-vs-claude-code | 2025年 |
| 11 | Tembo - Cursor vs Windsurf | https://www.tembo.io/blog/cursor-vs-windsurf | 2025年 |
| 12 | AyAutomate - Windsurf vs Cursor vs Claude Code 2026 | https://www.ayautomate.com/blog/windsurf-vs-cursor-vs-claude-code | 2026年 |
| 13 | Tessl.io - IDE Free Tier War | https://tessl.io/blog/ide-free-tier-war-windsurf | 2025年4月 |
| 14 | Reddit r/Codeium - Windsurf Launch | https://www.reddit.com/r/Codeium/comments/1gqr21i/introducing_windsurf_the_first_agentic_ide_and | 2024年11月 |
