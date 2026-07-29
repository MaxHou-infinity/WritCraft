# T1 · 笔触 · AI IDE 交互范式综合
> 调研时间：2026-07-14
> 调研人：houdah
> 数据来源：官方文档、官方博客、评测媒体、社区讨论（证据等级 A-C）
> 状态：T1 原始输出

---

## 数据源清单

| # | 来源 | URL | 时效 | 核心数据 |
|---|------|-----|------|----------|
| 1 | Cursor 官方产品页 | https://cursor.com | 2026-07 | Cursor 2.0 / Composer 2 / Tab / Agent |
| 2 | Cursor 官方博客 | https://cursor.com/blog/composer-2-technical-report | 2026-03 | Composer 2 RL 训练、多 Agent 并行 |
| 3 | Cursor 社区论坛 | https://forum.cursor.com | 2026-02 | Cmd+K Accept/Reject 行为 |
| 4 | Digital Applied | https://www.digitalapplied.com/blog/cursor-2-composer-ai-coding-agent-guide | 2025-11 | Cursor 2.0 Composer 模型规格 |
| 5 | Paradigm Digital | https://en.paradigmadigital.com/dev/windsurf-cascade-guide-best-practices | 2025 | Cascade 交互模式 |
| 6 | Devin.ai Docs | https://docs.devin.ai/desktop/cascade/memories | 2026-03 | Cascade Memories & Rules 持久化 |
| 7 | CodePick Dev | https://codepick.dev/en/guides/trae-cn-setup | 2025 | Trae CN 完全免费策略、模型列表 |
| 8 | Baidu Baike (EN) | https://baike.baidu.com/en/item/Trae/1481007 | 2025 | Trae 发展时间线、字节跳动内部政策 |
| 9 | InfoQ | https://www.infoq.com/news/2025/03/trae-bytedance-claude-37-free | 2025-03 | Trae 免费模型、SOLO 模式 |
| 10 | Hacker News | https://news.ycombinator.com/item?id=42799540 | 2025-01 | Trae 发布背景 |
| 11 | Alex Merced Blog | https://iceberglakehouse.com/posts/2026-03-context-windsurf | 2026-03 | Windsurf Flow 范式、上下文管理 |
| 12 | Stack Overflow | https://stackoverflow.com/questions/79879183 | 2025 | Cursor diff-based inline edit 技术原理 |
| 13 | Educative.io | https://www.educative.io/courses/advanced-cursor-ai/mastering-context-codebase-indexing-and--references | 2025 | Cursor Codebase Index 机制 |
| 14 | Engineer's Codex | https://read.engineerscodex.com/p/how-cursor-indexes-codebases-fast | 2025 | Cursor Merkle Tree 索引原理 |
| 15 | Digital Applied | https://www.digitalapplied.com/blog/windsurf-swe-1-5-cascade-hooks-november-2025 | 2025-11 | Windsurf SWE-1.5 / Cascade Hooks |
| 16 | Reddit r/windsurf | https://www.reddit.com/r/windsurf/comments/1onh9d5 | 2025 | Windsurf MCP 持久记忆 |
| 17 | hackmd.io | https://hackmd.io/@queaxtra/ByN843k_yl | 2025 | Trae vs Windsurf vs Cursor 对比 |

---

## 原始数据全文

---

## 一、六大核心交互范式

---

### 范式 1：AI 内联补全（Tab 触发 / 行级）

#### Cursor

- **触发方式**：按 `Tab` 键接受 ghost text（幽灵文字），无需鼠标操作
- **视觉呈现**：灰色半透明文字直接在光标位置渲染，覆盖在原文本上，替换后的内容以正常颜色显示-diff
- **用户接受/拒绝机制**：
  - `Tab` → 接受当前建议
  - `Esc` → 拒绝，等下一条建议
  - `Ctrl+Enter` → 重新生成（保留相同选择上下文）
  - `Ctrl+→`（或 `Ctrl+/`）→ 逐词接受（partial accept）
- **错误率**：社区反馈在 TypeScript/Vite 等复杂配置项目中，AI 有时会引入额外错误，用户需花 10-30 分钟调试修正；Copilot 比 Cursor 更容易出 bug（Reddit 2025 讨论），但 LLMs 本质上非确定性
- **写作 IDE 类比**：相当于写作工具的"输入补全预测"——输入"研究表明"，AI 预测完整句子并以灰色显示，用户按 `Tab` 接受

#### Trae

- **触发方式**：同样基于 `Tab` 键触发内联补全，与 VS Code 体验一致
- **视觉呈现**：灰色 ghost text，用户按 `Tab` 接受
- **用户接受/拒绝机制**：与 Cursor 相近，`Tab` 接受，`Esc` 拒绝
- **差异化**：支持切换多个模型（Doubao Seed Code / DeepSeek-V3 / DeepSeek-R1），不同模型对中文代码场景的补全质量有差异

#### Windsurf

- **触发方式**：`Tab` 键触发，但 Windsurf 的内联补全与 Cascade Flow 深度整合
- **视觉呈现**：Cascade 在 Flow 状态下会主动弹出 inline suggestion，以蓝/绿底色区分
- **用户接受/拒绝机制**：通过 `Tab` 接受；Windsurf 特有的 Cascade 非单向对话，用户可以中途修改指令
- **写作 IDE 类比**：相当于写作工具的"语境感知续写"——AI 理解当前章节语境后，在光标处弹出续写建议

#### 对 WritCraft 的借鉴价值

| 维度 | Cursor | Trae | Windsurf | WritCraft 适配方案 |
|------|--------|------|----------|------------------|
| 触发键 | `Tab` | `Tab` | `Tab` | 保持 `Tab` 接受，`Esc` 拒绝 |
| 视觉 | 灰色 ghost text + diff 着色 | 灰色 ghost text | 彩色底色区分 | 灰色虚字底 + 删除线/高亮 diff |
| 接受粒度 | 整行/逐词 | 整行 | 整行 | 句子级 + 段落级双粒度 |
| 拒绝机制 | `Esc` 拒绝 + 下一条 | 同左 | 中途改指令覆盖 | `Esc` 拒绝 + 重新生成 |

---

### 范式 2：悬浮快速修改（⌘K 选中改）

#### Cursor

- **选中范围**：选中代码片段后按 `⌘K`，在右侧打开 inline prompt 浮层
- **diff 呈现**：浮层中直接显示修改后的 diff，绿色代表新增，红色代表删除
- **撤销行为**：`Cmd+Z` 撤销整个 Composer 修改，而非逐字符撤销
- **多候选支持**：`Ctrl+Enter` 重新生成，保留同一选中区域但给出不同修改方案；`Cmd+K` → `Cmd+Y` = Apply，`Cmd+K` → `Cmd+N` = Reject
- **技术实现**（来源：Stack Overflow，2025）：实现方式为 diff-based 而非整文件替换——工具不是重写整个文件，而是在原文件中嵌入 diff patch，用户 accept 时应用该 patch

#### Trae

- **选中范围**：同样支持选中代码 + `Ctrl+K` 触发，交互方式与 Cursor 高度一致
- **diff 呈现**：浮层内显示 diff，绿色新增/红色删除
- **撤销行为**：支持撤销栈

#### Windsurf

- **差异化**：Windsurf 的 `Ctrl+K` 对应的是 Cascade 的 Quick Edit 能力，与 Cursor 略有不同：
  - Cascade Quick Edit 在 Flow 中被增强——上下文由 Flow 的会话历史提供，而非仅当前选中
  - 引入"Rules"——用户在 Rules 文件中定义项目级指令，Quick Edit 自动遵循这些规则

#### 对 WritCraft 的借鉴价值

| 维度 | Cursor | Trae | Windsurf | WritCraft 适配方案 |
|------|--------|------|----------|------------------|
| 触发方式 | 选中 + `⌘K` | 选中 + `Ctrl+K` | 选中 + `Ctrl+K`（Flow 增强） | 选中 + `⌘K` |
| diff 呈现 | 浮层内 inline diff | 同左 | Cascade 上下文内 diff | 写作场景下用"删除线+高亮"而非红绿 |
| 撤销行为 | `Cmd+Z` 全撤销 | 同左 | Flow 中可回退单步 | 撤销栈支持多步回退 |
| 多候选 | `Ctrl+Enter` 重新生成 | 类似 | Cascade 可中途改指令 | 同屏最多 3 个候选方案并列 |

---

### 范式 3：全局对话（⌘L 多文件上下文）

#### Cursor

- **上下文窗口管理**：
  - 左侧 AI Pane 显示对话历史（Chat 或 Composer tab）
  - `@file` 引用指定文件；`@git` 引用 git 历史；`@docs` 引用文档
  - 支持同时打开多个对话标签页（Tab）
- **多文件跳转**：
  - `@codebase` 全局搜索，让 AI 在整个代码库范围内回答问题
  - `Ctrl+L` 打开 Chat Panel，光标停留在当前文件，AI 可以跳转到其他文件
- **代码库索引**：Cursor 使用 Merkle Tree 做代码库索引，文件哈希树与服务器同步，支持快速语义搜索（来源：Engineer's Codex，2025）
- **长期记忆**：通过 AI Rules 定义持久上下文规则（项目级 / 全局级）；Agent Mode 下可创建持久记忆

#### Trae

- **上下文窗口管理**：
  - 同样基于 VS Code 架构，支持多文件侧边栏
  - `Ctrl+L` 打开 AI Chat Panel
- **多文件跳转**：
  - 支持 `@file` 引用；支持 `@folder` 引用整个目录
  - IDE Mode 下用户完全控制文件操作，AI 辅助但不替代
- **代码库索引**：Trae CN 的国内版针对中文注释和中文变量名有特殊优化（Doubao 1.5-Pro 模型）
- **长期记忆**：目前无原生 Rules/Memories 系统（与 Windsurf 相比偏弱）

#### Windsurf

- **上下文窗口管理**：
  - **Flow 范式**（Windsurf 特有）：AI 不是响应单次 Prompt，而是在整个开发过程中保持对任务、代码库、工作模式的持续感知
  - Cascade 在一个会话中维护"执行路径"，记录每一步操作和上下文
  - 支持多 Cascade 会话并行
- **多文件跳转**：
  - `@` 引用与 Cursor 类似，支持 `@file`、`@folder`、`@web`
  - Web Search 集成：在 Cascade 中直接搜索互联网并读取 URL
- **代码库索引**：
  - 使用 Codeium 的上下文引擎，对项目结构有深层感知
  - SWE-grep 提供 2,800+ tokens/秒的 Fast Context（来源：Digital Applied，2025-11）
- **长期记忆**：
  - **Memories**：Cascade 自动生成的记忆，存储在 `.devin/memories/` 中
  - **Rules**：用户定义的持久规则，在 `.devin/rules/` 或 `.windsurf/rules/` 中以 Markdown 编写
  - **AGENTS.md**：项目根目录的 `AGENTS.md` 文件会被自动注入所有 Cascade 对话的上下文

#### 对 WritCraft 的借鉴价值

| 维度 | Cursor | Trae | Windsurf | WritCraft 适配方案 |
|------|--------|------|----------|------------------|
| 对话入口 | `⌘L` Chat，`⌘I` Composer | `Ctrl+L` Chat | Cascade 侧边栏（Flow） | `⌘L` 写作对话面板（固定右侧） |
| 多文件上下文 | `@file` + `@codebase` | `@file` + `@folder` | `@file` + `@web` + Rules | `@chapter` + `@section` + `@archive` |
| 上下文窗口管理 | 多 Tab / 多会话 | 多 Tab | 多 Flow + 多 Cascade | 多 Tab 写作会话 |
| 长期记忆 | AI Rules（持久） | 无原生 | Memories + Rules + AGENTS.md | 写作项目规则集（持久化） |

---

### 范式 4：Composer 多文件自主编辑（Agent 模式）

#### Cursor

- **Composer**（2025-11 进入 2.0）：
  - 多文件编辑的核心界面，左侧文件树，右侧 AI Pane
  - Composer Model：Anysphere 自研的编码专用模型，通过 RL 训练，4 倍快于普通模型，支持并行工具调用
  - Agent Mode 下，Cursor 可读取整个代码库，生成并执行跨文件修改计划
- **多 Agent 并行**（Cursor 2.0，2025-11）：
  - 最多 8 个 Agent 并行运行，使用隔离的 git worktree 避免冲突
  - 用户可在 Agent Dashboard 中管理多个人工智体
- **任务分解**：
  - Agent 自动将复杂任务分解为子任务
  - 子任务可独立可视化（进度条 / 文件状态）
  - 支持中断恢复（断点续传）
- **错误回滚**：
  - 每个 Agent 操作后自动生成 git commit，便于回滚
  - 错误时 Agent 自动回退到上一个正确状态并重新尝试

#### Trae

- **SOLO Mode**（Trae 2.0，2025-09）：
  - 完全端到端自主模式——用户输入自然语言需求，Trae 完成从 PRD 到架构、代码、前端、后端、数据库连接、部署的全部工作
  - 与 Cursor Composer 的核心区别：SOLO 不需要用户分步操作，一个 prompt 完成全栈应用
- **Builder Mode**：
  - IDE Mode：用户主导，AI 辅助（类似传统 IDE）
  - SOLO Mode：AI 主导，用户审核（类似自动驾驶）
- **Agent 系统**（2025-04 引入）：
  - 支持 MCP 协议扩展（Figma design-to-code、数据库操作）
  - 支持 Figma 设计稿转代码

#### Windsurf

- **Cascade**（Windsurf 的 AI Agent）：
  - 多步自主：给定一个任务目标，Cascade 自动分解为多个步骤，逐个执行
  - 每一个步骤在 Cascade 中可视化，用户可以中断、修改指令
- **Workflows**（Windsurf 2.0 引入，2026）：
  - 四种工作流范式：Quick Task / Feature Build / Debug / Refactor
  - Workflow 可保存并重复使用——相当于"宏"+"AI 智能"的结合
- **错误回滚**：
  - Cascade 记录每一步操作历史
  - 用户可选择性地"回退到第 N 步"
  - 但 Windsurf 的回滚机制比 Cursor 的 git commit 方式弱

#### 对 WritCraft 的借鉴价值

| 维度 | Cursor | Trae | Windsurf | WritCraft 适配方案 |
|------|--------|------|----------|------------------|
| 多文件编辑入口 | Composer Panel | SOLO / IDE Mode | Cascade + Workflows | Plan Composer（写作大纲+多章节） |
| 任务分解 | 自动分解 + 可视化 | 一个 prompt 全流程 | Cascade 自动多步分解 | 章节分解 + 任务卡片可视化 |
| 中断恢复 | git commit 断点续传 | SOLO 中途可干预 | 步骤级回退 | 草稿版本链 + 中断恢复 |
| 错误回滚 | 每个操作生成 git commit | 可干预、可回退 | 步骤级历史回退 | 多版本草稿（不可覆盖） |

---

### 范式 5：@file 引用与文件树（结构化导航）

#### Cursor

- **引用语法**：
  - `@file <filename` 自动补全文件
  - `@folder` 引用整个文件夹
  - `@codebase` 语义搜索代码库
  - `@git` 引用特定 commit 或分支
  - `@docs` 引用项目文档
- **自动补全**：输入 `@` 后自动弹出文件树，用户模糊搜索即可
- **跨文件跳转**：在 Chat 中引用文件，AI 回答中会包含可点击的文件名，点击后直接在编辑器中打开
- **代码库索引**（来源：Educative.io + Engineer's Codex，2025）：
  - 文件打开时自动建立 Merkle tree 索引
  - 索引上传服务器做语义分析（Merkle tree 同步而非文件内容上传以保护隐私）
  - 用户可禁用 codebase indexing

#### Trae

- **引用语法**：
  - `@file` 与 Cursor 相同
  - `@folder` 引用整个目录
  - `@` 后自动弹出 IDE 内的文件列表
- **跨文件跳转**：AI 引用文件名后，用户点击直接跳转
- **中文语义优化**：对中文注释和中文变量名有特殊处理
- **与 Cursor 的差距**：无原生 Merkle tree 索引，文件搜索基于传统模糊匹配

#### Windsurf

- **引用语法**：
  - `@file` / `@folder` / `@web`
  - `@web` 可搜索互联网并在 Cascade 中直接读取 URL 内容
- **大观视图**：
  - Windsurf 2.0 引入 Code Map 可视化，显示代码库结构图谱
  - 类似项目结构的"鸟瞰图"，帮助理解大型项目
- **与文件的绑定**：Rules 文件定义在 `.windsurf/rules/` 中，可在项目间同步

#### 对 WritCraft 的借鉴价值

| 维度 | Cursor | Trae | Windsurf | WritCraft 适配方案 |
|------|--------|------|----------|------------------|
| 引用语法 | `@file` / `@folder` / `@codebase` | `@file` / `@folder` | `@file` / `@folder` / `@web` | `@chapter` / `@section` / `@reference` |
| 自动补全 | 模糊搜索 + 文件树 | 模糊搜索 | 模糊搜索 + Code Map | 章节树 + 引用推荐 |
| 跨文件跳转 | 点击文件名跳转 | 同左 | 点击跳转 + Code Map | 章节跳转 + 引用链路追踪 |
| 语义索引 | Merkle tree 索引（Cursor 专有） | 无 | Codeium 上下文引擎 | 写作语义索引（基于段落/论点） |

---

### 范式 6：错误处理与人机协作（Accept / Reject / 撤销）

#### Cursor

- **撤销栈**：独立的 AI 撤销栈（`Cmd+Z` 撤销 AI 修改，普通编辑的撤销栈不受影响）
- **Accept 全部 / Reject 全部**：
  - Composer 界面中有"Accept All"和"Reject All"按钮
  - 单个 hunk（代码块）的 accept/reject
- **协作信号**：
  - diff 中每个变更块标注 AI 置信度（高/中/低），帮助用户判断是否接受
  - AI 认为不确定的地方用黄色标注，提示用户重点审查
- **错误回滚**：每个 AI 操作后自动创建 git checkpoint，可精确回滚到任意操作节点

#### Trae

- **撤销栈**：基于 VS Code 的标准撤销机制，与 AI 修改融合
- **Accept / Reject**：SOLO 模式下用户扮演"审核者"角色，AI 完成后逐文件 Accept/Reject
- **协作信号**：无置信度标注（不如 Cursor 精细）

#### Windsurf

- **错误处理**：
  - Cascade 每个 Step 有"状态"标记（Pending / Running / Done / Failed）
  - Failed 的步骤可单独重试，不影响其他步骤
- **协作信号**：
  - Cascade Hooks：用户定义在特定操作前/后执行的规则（如 SOC 2 合规检查）
  - 用户的 Rules 体系会强制执行代码规范
- **撤销行为**：步骤级回退，而非文件级 git checkpoint

#### 对 WritCraft 的借鉴价值

| 维度 | Cursor | Trae | Windsurf | WritCraft 适配方案 |
|------|--------|------|----------|------------------|
| 撤销栈 | AI 专用撤销栈（独立于文本编辑） | 统一撤销栈 | 步骤级回退 | 草稿版本链（不删除历史） |
| Accept/Reject | 单块 + 全局 Accept/Reject | SOLO 逐文件审核 | 步骤级重试 | 句子/段落/章节三级审核 |
| 协作信号 | 置信度标注（高/中/低） | 无 | Cascade Hooks（企业合规钩子） | 写作立场标注（结论/来源/边界） |
| 错误回滚 | git checkpoint 精确回滚 | 可干预回退 | 步骤级重试 | 草稿版本回退（非覆盖） |

---

## 二、四个差异化机制

---

### Cursor：Composer + Codebase 索引 + 用户体验极简

- **Composer**：多文件编辑是 Cursor 的核心差异化体验，与 VS Code 的单文件编辑形成鲜明对比
- **Codebase 索引**：Merkle tree 索引让 AI 对整个项目有语义级理解，代码库问答成为可能
- **用户体验极简**：所有功能入口统一在 `⌘K`（inline edit）、`⌘L`（chat）、`⌘I`（composer）三个快捷键，界面简洁

---

### Trae：免费策略 + 字节跳动生态 + 中文 AI 模型整合

- **免费策略**：完全免费，无任何限制，这是 Trae 区别于 Cursor（$20/月）和 Windsurf（$15/月 Pro）的核心优势
- **字节跳动内部替代**：2025 年 6 月 30 日起，字节跳动内部全面停用第三方 AI 开发工具，转向 Trae——这意味着其内部用户规模巨大（来源：百度百科）
- **中文 AI 模型整合**：
  - Doubao-1.5-Pro（豆包）：国内场景优化
  - DeepSeek-V3/R1（深度求索）：复杂推理任务
  - Kimi K2：中文长文本处理
  - Qwen3-Coder：代码任务
  - 全部免费，无限使用（来源：CodePick）

---

### Windsurf：Cascade 多步自主 + Flow 实时感知 + MCP 生态

- **Flow 范式**：Windsurf 提出的新范式——AI 不是在每次对话中独立工作，而是在整个开发过程中保持对任务、代码库、用户工作模式的持续感知
- **Cascade 多步自主**：Cascade 将复杂任务分解为多个可管理的步骤，用户可中途修改指令
- **SWE-1.5 模型**（2025-11）：950 tokens/秒，13 倍快于 Claude Sonnet 4.5，原生图像理解（可用于截图调试 UI）
- **MCP 生态**：Model Context Protocol 支持多种扩展（数据库操作、Figma 设计稿转代码），构建 AI Agent 生态
- **Cascade Hooks**：企业级合规检查钩子（SOC 2 审计日志、数据脱敏）
- **Workflows**：可保存和重复使用的 AI 工作流范式

---

### 对 WritCraft 的借鉴价值

| 维度 | Cursor | Trae | Windsurf | WritCraft 适配 |
|------|--------|------|----------|---------------|
| 核心差异化 | Composer + 索引 | 免费 + 中文模型 | Flow + Cascade + MCP | Plan Mode + 学术数据库 + 结论溯源 |
| 用户体验哲学 | 极简三键 | 零成本 | 企业合规 | 专注写作流程不打断 |
| 技术护城河 | Merkle tree 索引 | 字节生态 + 免费 | Flow 实时感知 | 写作语义图谱 |

---

## 三、三个"绝对不能移植"的反模式

---

### ❌ 不移植"代码语法高亮"（写作没语法）

代码 IDE 有语法高亮，因为代码是形式语言，必须有语法结构才能执行。写作的内容（中文/英文长文）是自然语言，没有"语法错误"的概念——一个句子没有唯一正确的写法。

**写作的正确类比**：不是"语法高亮"，而是"论点结构高亮"——显示当前段落属于哪个论点层级、是否与章节主旨相关。

---

### ❌ 不移植"编译错误"概念（写作没编译）

代码 IDE 的错误处理基于编译器的"语法检查"——编译失败 = 代码有错，必须修复才能运行。写作没有编译器，写完的文本永远是"可运行的"。

**写作的正确类比**：不是"编译错误"，而是"论点一致性检查"——AI 检查当前章节是否与全局论点一致、是否存在自相矛盾。

---

### ❌ 不移植"Git diff"（写作没版本控制的内在需求）

代码 IDE 用 Git diff 是因为：代码修改需要追踪每一行的变化历史、需要在多人协作中合并冲突、需要在出错时回滚到特定版本。

写作的"版本控制"需求与代码不同：
- 写作的"版本"是草稿迭代（第一稿 → 第二稿 → 修改稿），不是文件的修改历史
- 写作不需要合并冲突（单人写作居多）
- 写作需要的是"版本对比"（两稿之间的论点变化），而不是"逐行 diff"

**写作的正确类比**：不是 Git diff，而是"论点演变图"——显示从第一稿到当前版本，核心论点和结构的演进。

---

## 四、五个"必须新增"的写作特有交互

---

### ✅ Plan Mode（写作框架 / 主旨 / 立意规划）

**定义**：用户在下笔之前，先通过 Plan Mode 构建整篇文章的骨架——章节结构、核心论点、论据布局。

**交互设计**：
1. 用户进入 Plan Mode，选择文章类型（论文 / 报告 / 书稿 / 专栏）
2. AI 根据用户输入的主题，生成多级章节大纲
3. 用户在可视化大纲中拖拽调整章节顺序
4. 每个章节节点可填写"本章主旨"（1-2 句话）
5. Plan Mode 完成 → 自动切换到写作模式，章节结构作为写作指引

**与代码 IDE 的本质区别**：代码 IDE 的 Plan 等同于"架构设计"（UML 图、流程图），而写作 Plan Mode 的输出是"论点树"——一种完全不同的结构。

---

### ✅ 章节内深度研究（自动调学术数据库）

**定义**：用户写作时引用某个学术概念，IDE 自动从学术数据库（arXiv、PubMed、CNKI 等）检索相关研究，并在写作上下文内联展示摘要和引用。

**交互设计**：
1. 用户输入 `@research <概念>`，IDE 自动查询学术数据库
2. 找到的论文以内联卡片形式展示（标题 + 作者 + 摘要 200 字）
3. 用户点击"引用"，自动生成学术引用格式，插入当前光标位置
4. 引用的论文进入文章的"参考文献"列表

**与代码 IDE 的本质区别**：代码的"research"是查文档（Stack Overflow、GitHub），而写作的"research"是查学术论文——这是完全不同的信息源和引用格式。

---

### ✅ 引用与脚注 Inline（自动生成参考资料）

**定义**：用户在写作时引用外部资料（书籍、文章、网页），IDE 自动补全引用信息，生成符合格式要求的脚注或尾注。

**交互设计**：
1. 用户输入 `@cite <来源关键词>`
2. IDE 从本地文献库（Zotero / EndNote）或网络搜索补全引用信息
3. 自动生成符合目标格式（APA / MLA / Chicago / GB/T）的引用
4. 脚注以内联小字形式显示在引用位置下方，不打断阅读流
5. 文章末尾自动生成参考文献列表

**与代码 IDE 的本质区别**：代码的"引用"是 `@file` 或 import 语句，而写作的"引用"是学术引用——需要多种格式支持、引文网络追踪、批量引用管理。

---

### ✅ 批注 + 评论（多人 + AI 批注）

**定义**：支持多人在同一篇文章上留下批注和评论；AI 也能主动对文章结构和论点质量留下"AI 批注"。

**交互设计**：
1. 选中任意文字 → 弹出批注工具栏（高亮 / 批注 / 提问）
2. 批注以侧边栏气泡形式展示，与正文不重叠
3. 批注支持@提及团队成员，被@的人收到通知
4. AI 批注以不同颜色标识（紫色 = 论点建议，蓝色 = 事实核查，黄色 = 逻辑检查）
5. 批注可标记"已解决"或"待讨论"

**与代码 IDE 的本质区别**：代码的"评论"是代码审查（code review），而写作的"批注"是编辑审稿——审稿人不改原文，只提意见；代码审查则直接影响代码质量。

---

### ✅ 结论溯源（每条 AI 输出标注"结论 / 来源 / 边界"）

**定义**：AI 在写作辅助中给出的每一项建议（论点、论据、表述方式）都附带明确的来源和适用边界，用户可以一键展开溯源。

**交互设计**：
1. AI 生成的每个句子右下角显示一个小标签："结论 / 来源 / 边界"
2. 用户鼠标悬停，显示详细溯源卡片：
   - **结论**：AI 生成内容的核心主张（一句话）
   - **来源**：AI 是从哪篇参考文章/哪个数据点得出的（标注文献编号）
   - **边界**：这个结论在什么条件下成立、什么条件下不适用
3. 用户可点击"争议"按钮，对溯源卡片提出质疑，AI 重新论证
4. 所有溯源信息导出时保留，支持生成"论证透明度报告"

**与代码 IDE 的本质区别**：这是写作 IDE 独有的范式——代码中 AI 的输出是"确定性的"（代码要么对要么错），而写作中 AI 的输出是"推断性的"（论点有强弱之分，边界有清晰有模糊），必须显式标注。

---

## 五、跨平台对比总表

| 交互范式 | Cursor 实现 | Trae 实现 | Windsurf 实现 | 写作 IDE 适配 |
|----------|------------|----------|--------------|-------------|
| AI 内联补全 | `Tab` ghost text，多行预测 | `Tab` ghost text（多模型切换） | `Tab` + Flow 上下文增强 | 句子级 ghost text，`Tab` 接受 |
| 悬浮快速修改 | `⌘K` 浮层 diff，`Cmd+Y` apply | `Ctrl+K` diff（类似实现） | `Ctrl+K` + Cascade Quick Edit | 选中 + `⌘K`，"删除线+高亮"diff |
| 全局对话 | `⌘L` Chat + `@codebase` 搜索 | `Ctrl+L` Chat + `@file` | Cascade Flow（持续感知） | `⌘L` 写作对话 + `@chapter` 导航 |
| 多文件自主编辑 | Composer 2 + 多 Agent 并行 | SOLO Mode（全流程自主） | Cascade 多步 + Workflows | Plan Composer（章节级分解） |
| @引用与文件树 | `@file` / `@folder` / `@codebase` + Merkle 索引 | `@file` / `@folder` | `@file` / `@folder` / `@web` + Code Map | `@chapter` / `@section` / `@reference` |
| 错误处理与人机协作 | AI 撤销栈 + Accept/Reject + git checkpoint | 统一撤销栈 + 逐文件审核 | 步骤级回退 + Cascade Hooks | 草稿版本链 + 句子/段/章三级审核 |

---

## 六、WritCraft 交互范式矩阵（可移植性评估）

| # | 范式名称 | 可移植性 | 移植说明 | 写作化改造要点 |
|---|----------|----------|----------|--------------|
| 1 | AI 内联补全（Tab） | ✅ 可移植 | 句子级 ghost text 替代代码行预测 | 灰色虚字 + `Tab` 接受 |
| 2 | 悬浮快速修改（⌘K） | ✅ 可移植 | 写作场景 diff 替代代码 diff | 删除线/高亮 diff，`Esc` 拒绝 |
| 3 | 全局对话（⌘L） | ✅ 可移植 | 写作对话 + 章节上下文 | 右侧面板 + `@chapter` 引用 |
| 4 | 多文件自主编辑 | ✅ 可移植（Plan Composer） | 章节结构多文件类比 | 章节分解 + 任务卡片 + 中断恢复 |
| 5 | @引用与文件树 | ✅ 可移植 | `@chapter`/`@section` 替代 `@file` | 语义索引替代代码 Merkle tree |
| 6 | 错误处理与协作 | ⚠️ 需改造 | 论点一致性替代编译错误 | 草稿版本链 + 置信度标注 |
| 7 | Plan Mode | 🆕 必须新增 | 无代码类比 | 写作框架/主旨/立意规划 |
| 8 | 章节内学术研究 | 🆕 必须新增 | 无代码类比 | 自动调 arXiv/CNKI 等学术数据库 |
| 9 | 引用与脚注 Inline | 🆕 必须新增 | 无代码类比 | 学术引用格式自动补全 |
| 10 | 批注 + 评论 | 🆕 必须新增 | 无代码类比 | 多人编辑批注 + AI 批注 |
| 11 | 结论溯源 | 🆕 必须新增 | 无代码类比 | 每条 AI 输出标注"结论/来源/边界" |

---

*文件路径：`<repository-root>/raw/cursor-trae-research/_interaction-patterns.md`*
*字数：约 8,500 字*
*最后更新：2026-07-14*
