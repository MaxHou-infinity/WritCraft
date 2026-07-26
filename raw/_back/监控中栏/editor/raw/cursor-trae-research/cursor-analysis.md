# Cursor AI IDE 深度分析

> 数据收集自：cursor.com 官方文档与博客、Cursor 社区论坛、第三方评测
> 时效：2026年7月（基于 Cursor 3.x / Composer 2.x 版本）

---

## 1. 产品定位与公司背景

| 维度 | 信息 |
|------|------|
| 公司名 | Anysphere |
| 成立 | 2023年 |
| 融资 | 2026年估值约 $9B |
| 产品定位 | AI-Native Code IDE（基于 VS Code 分叉） |
| 2026年ARR | 超过 $500M |

---

## 2. 关键交互机制（≥3个）

### 2.1 Composer（作曲器）

Composer 是 Cursor 自研的专有编码模型，于 2025年10月随 Cursor 2.0 发布，2026年迭代至 Composer 2.5。

**核心交互方式：**
- 用户提出高层目标（如"实现登录功能"），Composer 自动将任务拆解为多个子任务
- 任务在 **git worktree** 或远程机器上并行执行，每个子 agent 有独立工作集
- **多文件 diff 逐句接受机制**：Composer 产生的变更以 floating diff 形式呈现，用户逐句接受（Accept）/拒绝（Reject），而非一次性替换整个文件
- Composer 2.5 支持 `@` 引用文件、`/` 调用命令（Composer 2.5 · n/ for commands · @ for files）
- 支持 **Plan Mode**：Agent 先提出澄清问题，生成计划，用户确认后再后台执行

**典型工作流：**
```
用户: "let's build a mission control interface"
Composer → 分析需求 → 生成多步计划 → 分派子 agent → 
逐文件 diff 呈现 → 用户逐句接受 → 完成
```

### 2.2 Multi-Agent 并行面板

Cursor 3.0（2026年初）推出 Agents Window，支持同时运行最多 8 个并行 Agent，每个 Agent 有独立：
- 工作文件范围（per-task scope）
- 选用的模型
- 审批策略（approval policy）

**交互细节：**
- 不同 Agent 可分别运行在 Opus-4.8、Composer 2.5、GPT-5.6 Sol、Gemini 3.1 Pro 等不同模型上
- Agent 之间通过 **Mission Control** 界面统一管理（网格视图预览所有窗口）
- 支持 **Multi-Agent Judging**：同一任务让多个模型同时尝试，选取最佳结果
- 任务添加通过 ⌘K 触发

### 2.3 Tab（自动补全）

**交互方式：**
- 按 Tab 键接受下一个 token（逐词补全，非段落）
- 基于强化学习驱动的 specialized sparse model
- speculative decoding：利用已有源代码作为"草稿 token"，使 70B 模型达到 ~1,000 tokens/秒
- RL 训练循环：每 90 分钟根据用户接受/拒绝行为重新训练，每天部署多个新 checkpoint
- 400M+ 请求/天的线上反馈数据

### 2.4 Floating Diff（悬浮差异窗口）

**具体交互模式：**
- AI 产生的代码变更以浮动窗口形式呈现
- 每一条变更（hunk）是独立可操作的
- 用户逐句接驳（step-by-step acceptance）
- diff 窗口可以折叠、展开、逐文件审查
- Composer 模式下多文件变更（multi-file diff）可统一 review

### 2.5 Plan Mode

- AI 先提出澄清问题（如"任务范围需要确认：手势还是快捷键？"）
- AI 生成 Mermaid 格式计划图
- 用户审阅计划，确认后才开始执行
- 支持在 Composer 上下文中调用 Plan Mode

---

## 3. 架构设计

### 3.1 AI Context 机制

**Workspace Indexing（代码库索引）：**
- Cursor 使用自定义 embedding model 对整个代码库做语义索引
- Agent 可进行 codebase-wide 语义搜索（Composer 内置）
- 安全索引：可安全复用队友的现有索引，将最大代码库的首次查询时间从数小时缩短到秒级

**Context 层级：**
1. **全局索引**（workspace-level semantic index）
2. **.cursor/rules/** 目录（MDC 格式项目级规则）
3. **MCP Server**（Model Context Protocol，支持第三方扩展）
4. **动态上下文发现**（Dynamic Context Discovery）：模型根据任务自主拉取相关上下文
5. **Subagent 独立 context**：每个并行 Agent 有自己的工作集和 context

**Context 管理已知问题（社区论坛 B/C级证据）：**
- "Poor context management — new window required every few turns"：对话 5-10 轮后，上下文退化，Agent 开始遗忘早期细节，必须开新窗口
- 自定义模型的 context window 默认设为 1M token，无 UI 可手动调整
- Context 随对话轮次增长而退化是新窗口变成"唯一解决方案"

### 3.2 文件组织方式

- `.cursor/rules/` 目录：存放 MDC 格式的规则文件，每个任务类型可对应一个规则文件
- 团队规则（Team rules）：`.cursor/rules/` 可跨团队共享，规定代码风格、建筑决策等
- 项目可配置 `.cursorignore` 排除特定文件不被索引

### 3.3 多模型支持

- 开放模型选择器：支持 Opus-4.8、GPT-5.6 Sol、Gemini 3.1 Pro、Composer 2.5 等
- 每个 subagent 可独立选择模型
- 支持 **Custom Model**（BYOK）：用户接入自己的 OpenAI-compatible API model，Cursor 默认设 1M token context window
- Cloud Agents：云端运行的 Agent，支持 Slack/GitHub/Linear 触发

---

## 4. 收费模式

| 档位 | 价格 | 主要权益 |
|------|------|----------|
| Free | $0 | 500 completions, 20 Composer requests, 2000 context requests |
| Pro | $20/月 | 无限制 completions, 500 Composer requests, 优先模型 |
| Pro+ | $60/月 | 更高 Composer 配额，Max Mode 支持 |
| Ultra | $200/月 | 最高配额，专用资源 |
| Business / Enterprise | 定制 | SSO、SOC 2、安全合规 |

> 所有付费档位均基于 **metered usage model**（按量计费），每个请求消耗等效积分。

---

## 5. 已知局限 / 问题（B/C 级证据）

### 局限1：上下文快速退化（社区论坛 Official - 高可信）
**来源：** Cursor 官方社区论坛帖子 "Poor context management — new window required every few turns"（162416）
**内容：** 对话进行 5-10 轮后，Agent 开始遗忘早期细节、重复工作、响应变慢。官方回复确认是 limited context window 问题。**这是设计问题，不是 bug**——官方建议为每个新任务开启新 chat。

### 局限2：版本更新后代码质量下降（Reddit - C级）
**来源：** r/cursor 多篇帖子（1jn9hkv, 1krkp15, 1mc5f8p）
**内容：** "新版本感觉完全不一样，经常产生破碎结果、引入更多 bug，难以正确遵循指令"；"Cursor 最终会变得无用"；付费用户抱怨游戏代码越改越差。

### 局限3："Unable to reach the model provider" 错误（官方论坛 - 高可信）
**来源：** Cursor 官方社区论坛最新帖子（2026年7月13-14日）
**内容：** 多个用户报告 v2 模型提供连接失败（Bug Reports → performance, networking），7月13日出现 "phantom workspace" bug 导致 chat 被迁移到不存在的 workspace。

### 局限4：Token 费用不可预测（Reddit - C级）
**来源：** r/cursor 社区讨论
**内容：** Max Mode 下三个并行 Agent 使用 frontier model，费用是单 Agent 串行的三倍，用户对 token 消耗速度感到惊讶。

### 局限5：Auto Mode 质量问题（Reddit - C级）
**来源：** r/cursor
**内容：** Auto 模式下模型选择不智能，用户反映产生的结果质量不稳定。

### 局限6：自定义模型 Context Window 默认值过高（官方论坛 - B级）
**来源：** Cursor 官方论坛 "Custom Models Set The Context Window to 1M" (160106)
**内容：** 添加自定义 OpenAI-compatible API model 时，Cursor 默认将 context window 设为 1M token，无法自动检测真实值，也无 UI 可手动调整。

---

## 6. 跨平台能力

| 平台 | 支持情况 |
|------|----------|
| macOS | ✅ 官方支持 |
| Windows | ✅ 官方支持 |
| Linux | ✅ 官方支持 |
| iOS | ✅ Cursor Mobile App（2026年3月发布） |
| Android | ✅ Cursor Mobile App |
| CLI | ✅ Cursor Agent CLI |
| JetBrains IDE | ✅ 插件形式 |
| Web | ✅ Cloud Agents |
| Slack | ✅ 集成 |
| Linear | ✅ 集成 |
| GitHub | ✅ PR review 集成 |

---

## 7. 企业级特性

- **BugBot**：GitHub PR 自动审查服务
- **Background Agents**：云沙箱中运行，开发者在本地可同时做其他工作
- **SSH Remote Development**：支持远程机器上运行 Agent
- **MCP Server 支持**：允许 IDE 连接真实基础设施
- **Team Rules**：团队级代码规范同步
- **Workspace-level 安全索引**：企业代码不出本地

---

## 8. 数据来源清单

| # | 来源 | URL | 时效 | 核心数据 |
|---|------|-----|------|----------|
| 1 | Cursor 官方博客 | https://cursor.com/blog/2-0 | 2025年10月 | Composer 2.0 发布信息 |
| 2 | Cursor 官方产品页 | https://cursor.com/product | 2026年7月 | 全产品功能矩阵 |
| 3 | Cursor 官方 Changelog | https://cursor.com/changelog | 持续更新 | 版本迭代记录 |
| 4 | Cursor 社区论坛 | https://forum.cursor.com/latest | 2026年7月 | 已知问题与反馈 |
| 5 | Digital Applied 深度评测 | https://www.digitalapplied.com/blog/cursor-3-deep-dive-agents-composer-review-2026 | 2026年 | Cursor 3.0 深度分析 |
| 6 | Tech Insider 教程 | https://tech-insider.org/cursor-tutorial-ai-code-editor-2026 | 2026年 | 完整功能教程 |
| 7 | The AI Engineer 架构解析 | https://theaiengineer.substack.com/p/how-cursor-actually-works | 2026年 | Tab model 技术原理 |
| 8 | Petronella Tech 安全指南 | https://petronellatech.com/blog/cursor-ai-ide-setup-guide | 2026年 | 企业安全配置 |
| 9 | DeployHQ 指南 | https://www.deployhq.com/guides/cursor | 2026年 | 完整使用指南 |
| 10 | Reddit r/cursor | https://www.reddit.com/r/cursor | 2026年7月 | B/C 级用户体验问题 |
| 11 | Cursor 官方论坛 162416 | https://forum.cursor.com/t/poor-context-management-new-window-required-every-few-turns/162416 | 2026年 | 上下文管理问题 |
| 12 | Cursor 官方论坛 160106 | https://forum.cursor.com/t/custom-models-set-the-context-window-to-1m/160106 | 2026年 | 自定义模型 context 问题 |
| 13 | Cursor 官方论坛 47515 | https://forum.cursor.com/t/plans-to-support-custom-composer-agents-or-cursor-apis/47515 | 2025年8月 | API 扩展需求 |
| 14 | Cursor 3 Glass 评测 | https://dev.to/gabrielanhaia/cursor-3-glass-replaced-composer-with-an-agents-window-1pcg | 2026年 | Cursor 3 Agents Window |
| 15 | Cursor iOS 发布 | https://cursor.com/blog/ios-mobile-app | 2026年6月 | 移动端发布 |
