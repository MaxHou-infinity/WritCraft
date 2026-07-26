# Windsurf 调研简报

> 调研日期：2026-07-14
> 产品：Windsurf（Codeium 旗下 AI IDE）
> 定位：2024 AI IDE 第二波挑战者，Cursor 对照系

---

## ① 一句话定义

Windsurf 是 Codeium 于 2024 年 11 月推出的 AI 原生代码编辑器（VS Code 分叉），核心定位是"首个 Agentic IDE"，通过 Cascade Agent + Flows 双模式让 AI 在 copilot（辅助建议）和 agent（自主执行）之间无缝切换，定价低于 Cursor。

---

## ② 与 Cursor 的核心差异（3–5 个）

| 维度 | Windsurf | Cursor |
|------|----------|--------|
| **定价** | Free（25 credits/月）+ Pro $15/月（500 credits）+ Tab 补全全免费 | Free（有限）+ $20/月 |
| **计费模型** | Credit-based；SWE-1 自研模型按 interaction 固定扣费，token 消耗可预测 | 按 token 量计费，大会话可能超预期 |
| **AI 模式** | Flows：copilot ↔ agent 无缝融合，无需手动切换 | Composer：多 agent（最多8个）并行，需明确切换 |
| **上下文感知** | 全局 codebase RAG 自动索引，无需手动标注文件；开发者测评"一次找到正确文件" | 需手动 tag 文件或额外提示关键词 |
| **自有模型** | SWE-1（Codeium 自研，专为软件工程任务优化） | 采购第三方模型（Claude、GPT-4o） |
| **补全速度** | Supercomplete 多行预测，明显更快 | 补全响应约 45ms（92% 准确率） |

---

## ③ 定价（2026 年 4 月更新）

| 计划 | 价格 | 内容 |
|------|------|------|
| Free | $0 | 每月 25 credits；Tab 补全不限量 |
| Pro | $15/月 | 500 credits；Chat/Cascade/Command 均消耗 credits |
| Add-on | $10/次 | 250 Flex credits（可混用 User Prompt / Flow Action） |

> 注：2026 年 4 月前为 Unlimited Pro 订阅，后改为 credit 制度。SWE-1 模型固定 credit 消耗，Claude Sonnet 4.6 / GPT-4.1 按 token 量消耗。

---

## ④ 借鉴 WritCraft 的 3 个设计点

### 4.1 Flow State 导向的产品隐喻

Windsurf 名称取自 windsurfing（帆板运动）的"流态"体验。产品在宣传中明确强调"maintain your flow state"——AI 的介入不应打断开发者的心流。设计细节包括：补全延迟压到最低、Cascade 执行任务时界面保持非阻塞、Flows 在 copilot/agent 模式间静默切换而非强迫用户决策。

**对 WritCraft 的借鉴**：WritCraft 若强调"沉浸式长文写作不打断思路"，可以在 AI 介入时机、建议呈现方式（轻提示 vs 强阻塞）上借鉴 Flow State 哲学。

### 4.2 Copilot ↔ Agent 双模式融合（Flows）

传统 AI IDE 要么是 copilot（你写 AI 帮补），要么是 agent（你描述 AI 执行）。Windsurf 的 Flows 范式让两者融合：AI 实时感知开发者动作，自动在"辅助建议"和"自主执行"间切换，无需用户显式切换模式。开发者描述一个目标，AI 自动判断是需要逐步确认还是直接执行。

**对 WritCraft 的借鉴**：写作工具中，"AI 补写句子/段落"（copilot 模式）和"AI 自主完成整章大纲"（agent 模式）可以融合为单一 Flows 交互——根据写作者当前状态（打字中/暂停/明确指令）动态调整 AI 介入深度。

### 4.3 自动全局 Codebase RAG 索引

Windsurf 在后台自动对整个代码库建立语义索引，用户提问或下达任务时，AI 主动检索相关文件上下文，无需手动选择文件或添加 prompt 前缀。评测中"Windsurf found the file in the first try, Cursor needed additional prodding"验证了这一优势。

**对 WritCraft 的借鉴**：文档写作场景中，全局文档库 RAG 索引 + AI 主动关联相关章节/引用的设计，可以让写作者在引用背景资料时无需手动复制粘贴，AI 自动感知当前写作上下文并补全相关素材。

---

## ⑤ 引用清单

| # | 来源 | URL | 时效 | 核心数据 |
|---|------|-----|------|----------|
| 1 | PE Collective | https://pecollective.com/tools/windsurf | 2026-04 更新 | 定价 Free/Pro $15；Cascade Agent；SWE-1 模型；credit 制度 |
| 2 | PinkLime Review | https://pinklime.io/blog/windsurf-codeium-review-2026 | 2026 | Cognition $82M ARR 收购；OpenAI $3B 收购未成；Google 挖人；Flows 融合模式；全局 RAG 索引 |
| 3 | MindStudio | https://www.mindstudio.ai/blog/what-is-windsurf | 2025 | Flows 双模式融合；Cascade agent 架构；SWE-1 自研模型 |
| 4 | Augment Code对比 | https://www.augmentcode.com/tools/cursor-vs-windsurf-codeium-feature-and-price-guide | 2025-11/2026-06 | 上下文感知差异；"一次找到正确文件"评测 |
| 5 | Prommer AI Guide | https://prommer.net/en/tech/guides/cursor-vs-windsurf | 2026 | 定价对比 $15 vs $20；Quick Verdict |
| 6 | Navs.site | https://navs.site/en/blog/codeium-windsurf-ai-editor | 2024 | Flow State 产品哲学；AI Flows 范式定义 |
| 7 | WebWire (Press Release) | https://www.webwire.com/ViewPressRel.asp?aId=329485 | 2024-11-13 | 首个集成预测 AI 代码编辑器；实时协作 |
| 8 | Product Hunt | https://www.producthunt.com/products/windsurf | 2024-11 | Launch Day #5 of Day |
| 9 | Ryz Labs | https://learn.ryzlabs.com/ai-coding-assistants/ai-coding-assistant-showdown-cursor-vs-codeium-vs-windsurf | 2026-04 | 三者对比表：Windsurf $20(旧)/$15(新) vs Codeium Free vs Cursor $10 |
| 10 | Forbes（存档） | 原文 404；但 WebWire/其他二次引用确认 Forbes 2024-11-13 报道"bridging gap between human and AI coding" | 2024-11-13 | 媒体报道背书 |
