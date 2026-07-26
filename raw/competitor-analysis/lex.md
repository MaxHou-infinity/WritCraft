# Lex 横评报告

> 证据等级：B（官方页面 + Tooliverse 评测），C（YouTube 评测/年度公开信）
> 时效：2026年（Lex 最新版本，lex.page）
> 数据来源：lex.page 官方页面、Tooliverse.ai、Lex Annual Letter (buttondown.com/lex)、YouTube Tool Finder 评测

---

## 一、产品定位

Lex（Lex, Inc.，美国，创始人 Nathan L.）是一款**以 AI 为核心的极简写作工具**，口号是"Write something great today"。定位为 Google Docs 的 AI 替代品，核心用户是专业写作者和内容创作者。官网自称目前有 300,000+ 写作者用户。**Lex 是六款竞品中 AI 整合程度最高的产品，但写作结构化支持最弱。**

---

## 二、核心功能描述（证据等级 A/B）

### 2.1 极简编辑器
- 无格式化工具栏，默认纯文本输入
- 通过 Markdown 语法控制格式（# 标题、**粗体**、*斜体*等）
- 极简界面，无分心模式（但界面本身即为分心极简设计）
- 以自然光/深色模式切换

> 证据：A — lex.page 官方产品页面

### 2.2 AI 辅助（核心差异化）
Lex 的 AI 功能是其最主要特色：
- **AI Feedback（AI 反馈）**：选中文字，AI 给出修改建议、评价、重新表述选项
- **Commands（命令）**：通过 `/` 命令触发 AI 操作，如 `/fix` `/rewrite` `/improve`
- **Title Ideas**：一键让 AI 生成多个标题备选
- **Continue Writing**：让 AI 续写当前段落
- **Ask AI**：对全文或选中文本进行问答、讨论
- AI 模型：GPT-5、Claude 4.1 Opus、Claude 3.5 Sonnet（Pro 用户可选）

> 证据：B — lex.page 官方功能说明；Tooliverse.ai 2026 评测

### 2.3 版本历史（Versions）
- 每次重要编辑后自动保存历史版本
- 可在多个版本之间切换
- 可对版本添加标签（Labels）

> 证据：A — lex.page 官方

### 2.4 评论（Comments）
- 选中文字添加评论
- 支持键盘快捷键导航
- 评论可被解决（Resolved）

### 2.5 实时协作
- 多人同时编辑，实时同步
- 通过链接分享，无需账号即可查看（编辑需注册）
- 协作编辑时可见对方光标

> 证据：A — lex.page 官方

### 2.6 发布（Publishing）
- 可将文档发布为"只读链接"
- 适合公开文章、博客文章发布
- 不支持复杂排版，仅纯文本 + Markdown 格式

---

## 三、AI 功能现状（重点）

### 3.1 内置 AI
- **有**，Lex 是六款竞品中 AI 整合程度最深的产品
- AI 功能内嵌于编辑器，无需切换到外部 AI 工具
- AI 在用户选中文字或发出命令时触发，不主动生成内容

### 3.2 接入哪家模型
- **GPT-5**（OpenAI）
- **Claude 4.1 Opus**（Anthropic）
- **Claude 3.5 Sonnet**（Anthropic）
- Pro 用户可在这三个模型中选择，免费用户仅限基础模型

> 证据：B — Tooliverse.ai 2026 评测；lex.page 官方

### 3.3 收费
| 层级 | 价格 | 内容 |
|------|------|------|
| 免费 | $0 | 基础 GPT 模型，限量使用 |
| Lex Pro | 未公开（官网仅说明"每月"） | 优先使用 Claude Opus、GPT-5，无使用限制，隐私保护 |
| Lex Teams | 未公开 | 团队协作功能 |

> 证据：B — lex.page/pricing

### 3.4 AI 能力的核心局限
1. **无逐句 diff**：AI 的修改建议以替换文本呈现，用户接受/拒绝是以段落为单位，无法做到逐句悬浮 diff
2. **无 Plan Mode**：Lex 无写作计划/大纲规划功能
3. **无结构化写作支持**：无多层级大纲、章节管理、脚注、交叉引用
4. **上下文窗口限制**：AI 仅能理解当前文档，无法跨文档理解项目整体结构

> 证据：B — Tooliverse.ai 评测："The AI writing assistant that enhances rather than replaces your creative process"

---

## 四、结构化写作支持

| 维度 | 支持情况 | 备注 |
|------|---------|------|
| 大纲（多级标题） | ⚠️ 仅 Markdown H1-H3，无独立大纲视图 | 非书籍写作工具 |
| 章节 | ❌ 无章节概念，纯线性文档 | 不适合结构化长文 |
| 脚注 | ❌ 无脚注功能 | |
| 引用 | ❌ 无交叉引用 | |
| 备注/注释 | ✅ Comments 功能（但非批注） | |
| 图片 | ❌ 无图片插入功能 | 纯文本工具 |
| 多媒体 | ❌ 无 | |

**结构化写作综合评估：极弱。** Lex 是"线性文档"写作工具，不支持任何结构化长文写作特性。

---

## 五、已知局限（证据等级 B/C）

### 5.1 无结构化写作能力（核心硬伤）
- 无章节/多层级文档组织
- 无脚注、无交叉引用
- 无大纲视图、无 Plan Mode
- 无图片/图表支持

### 5.2 隐私问题
- Lex 官方承认将用户写作内容用于 AI 模型训练（除非订阅 Pro）
- Pro 版本明确声明不将用户内容用于训练

> 证据：A — lex.page/pricing："Lex literally pays for this additional privacy on your behalf"

### 5.3 功能不稳定
- 作为一个相对小的创业公司，功能迭代较快但不保证稳定性
- 某些功能（如 Track Changes）仍在开发中（"Coming soon"）

### 5.4 非离线可用
- 100% 云端，依赖网络连接
- 离线无法写作

---

## 六、对 WritCraft 的意义

| 维度 | 启示 |
|------|------|
| AI 内嵌体验 | Lex 证明"AI 在编辑器内内嵌而非对话式"是正确方向，但实现层次浅 |
| AI 即时反馈 | Lex 的 "AI Feedback" 功能是"逐句修改"的早期形态，但缺乏逐句 diff |
| 极简主义 | Lex 的极简 UI 是对"分心写作"需求的精准回应，WritCraft 需平衡功能与简洁 |
| 隐私模式 | Pro 版隐私模式（不训练模型）是一个值得考虑的商业化路径 |
| 结构化空白 | Lex 几乎无结构化写作支持，证明这是 AI 写作工具普遍忽视的维度 |
| 多模态缺失 | Lex 完全没有图片/图表/多模态支持，与 WritCraft 多模态战略形成鲜明对比 |

**核心结论：Lex 是"AI-first 线性写作工具"，是 AI 写作体验的先行者，但其在结构化写作方面的空白，恰好是 WritCraft 的核心机会。Lex 的 AI 是对话式的——它只能修改当前段落，无法做到"基于项目级大纲的章节修改"，这正是 WritCraft 架构的根本差异。
