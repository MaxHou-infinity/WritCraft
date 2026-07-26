# Scrivener 横评报告

> 证据等级：A（官方文档/官方帮助），B（头部评测/作者访谈）
> 时效：2025年，主力版本 Scrivener 3 for macOS/Windows（iOS 同步）
> 数据来源：Literature & Latte 官网、官方帮助文档 Cornell University LibGuides、DigitalSoftwareLabs 评测

---

## 一、产品定位

Scrivener 是由 Literature & Latte（英国）开发的桌面端长文写作工具，2007年首发 Mac，主力用户为小说作者、学者、编剧。核心哲学：**"赋能写作者思考、规划和创作，不受干扰"**。离线优先，无云端协作，无内置 AI。

---

## 二、核心功能描述（证据等级 A/B）

### 2.1 Binder 组织架构（核心）
Scrivener 以"活页夹"（Binder）为核心，支持将项目分解为多层级文件夹和文本文件：
- 三层嵌套文件夹（Part > Chapter > Scene）
- 每个文本节点独立编辑，节点内可包含多个小节
- 支持跨节点引用（cross-references）和链接
- 节点拖拽重排，Binder/大纲/软木板三视图同步

> 证据：A — 官方文档 "Use Folders and Texts to Power Up the Scrivener Binder"

### 2.2 Corkboard 软木板视图（特色）
将每个场景以索引卡（index card）形式呈现，支持：
- 卡片正面显示 synopsis（概要），背面可写详细笔记
- 拖拽调整顺序，颜色标签分类
- 三种软木板视图：标准视图、分组视图、筛选视图
- 卡片变更自动同步到 Binder 和 Outliner，三视图实时联动

> 证据：A — Literature & Latte 官方博客 "Organize Your Scrivener Project with the Corkboard"

### 2.3 Outliner 大纲视图
- 以层级列表形式显示所有节点
- 支持直接在大纲中编辑标题和 synopsis
- 可按字符数/字数统计显示
- 节点可设置元数据（label、status、custom meta）

> 证据：B — Scrivener 官方功能介绍

### 2.4 Compile 编译系统
将分散的多个文本节点合并输出为单一文档：
- 支持输出为 Word、PDF、ePub、Mobi、HTML 等格式
- 可自定义每一层的格式化规则（章节标题样式、正文缩进等）
- 预设多种编译预设（论文、小说、剧本等）
- 编译预览功能

> 证据：A — Scrivener 官方文档

### 2.5 Research 研究资料管理
- 在项目中内置"研究文件夹"，可放入 PDF、图片、网页剪藏
- 研究资料与写作文本并列存在，无需切换应用
- 支持在笔记中标注和引用研究资料

> 证据：B — Cornell University LibGuides："Your writing will not be accessible by AI (unless you choose to share it outside of Scrivener)."

---

## 三、AI 功能现状

### 3.1 内置 AI
**无。** Scrivener 官方明确确认：软件本身不包含任何 AI 写作或编辑辅助功能。

> 证据：A — Scrivener 官方功能页面 + Cornell LibGuides："The software described on this guide does not currently utilize AI."

### 3.2 第三方 AI 集成
- **无原生集成**：Scrivener 不提供官方 AI 插件或 API 集成
- **用户自集成**：用户可将 AI 输出手动粘贴到 Scrivener 中，或通过 Mac 的系统级 AI（Apple Intelligence，macOS 15.1+）调用外部 AI 辅助
- **外部工具链**：用户通常将 Scrivener 作为纯写作层，配合 ChatGPT/Claude 等外部 AI 工具进行构思和改写

### 3.3 AI 接入哪家
不适用——Scrivener 无任何 AI 原生接入。

### 3.4 收费与否
纯本地/离线工具，无 AI 收费组件。

---

## 四、结构化写作支持

| 维度 | 支持情况 | 证据 |
|------|---------|------|
| 大纲（多级标题） | ✅ 三层嵌套 Part > Chapter > Scene | A |
| 章节（独立节点） | ✅ 每个节点独立，可任意重组 | A |
| 引用（脚注/尾注） | ✅ 支持 footnote 和 endnote，编译时保留 | A |
| 脚注 | ✅ 内置脚注工具，编译到 Word/PDF 时保留 | A |
| 交叉引用 | ✅ 支持文内 cross-reference 链接 | B |
| 备注/注释 | ✅ 每个节点可附加笔记（Notes） | A |
| 研究资料内联 | ✅ 研究文件夹与写作文本同项目存在 | A |
| 图片/图表 | ✅ 支持插入图片，编译输出 | A |

**结构化写作综合评估：强。** Scrivener 的 Binder + Outliner + Corkboard 三视图体系对长文结构化支持极为完善，特别适合书籍和论文的多层级组织。

---

## 五、已知局限（证据等级 B/C）

### 5.1 无 AI 能力
**最大局限。** 在 2025 年 AI 驱动写作工具横行的背景下，Scrivener 坚持"无 AI"哲学，刻意保持纯写作工具定位。用户必须自行拼接外部 AI 工具。

> 证据：B — "Unlike modern AI-driven tools, Scrivener doesn't include automated writing or editing assistance."（DigitalSoftwareLabs 2025 评测）

### 5.2 学习曲线陡峭
新用户普遍反映 Scrivener 上手难度高，Binder 概念和 Compile 系统需要专门学习。

> 证据：B — "New users may find Scrivener writing software complex at first, requiring time to understand its full potential."

### 5.3 无内置协作功能
不支持实时多人协作，无云端同步（需依赖 iCloud/Dropbox/OneDrive 第三方同步）。

> 证据：C — 来自 App Store 和 G2 用户评论

### 5.4 移动端功能弱
iOS 版本功能远少于桌面版，无法完整替代桌面工作流。

> 证据：C — Reddit r/scrivener 多位用户反馈

### 5.5 文档间引用能力有限
仅支持同一项目内的 cross-reference，跨项目引用需要手动复制或借助第三方工具。

### 5.6 纯文本导向，多媒体支持有限
图片插入能力基本，更复杂的数据可视化、表格、图注等支持不如 Notion。

---

## 六、对 WritCraft 的意义

| 维度 | 启示 |
|------|------|
| 结构化多层级大纲 | Scrivener 的 Part > Chapter > Scene 体系是 WritCraft 大纲系统的参考原型 |
| Corkboard 视觉组织 | 逐句 diff 修改的 UI 可参考卡片式布局呈现修改差异 |
| 研究内联 | "研究资料与写作同界面"的设计哲学高度吻合 WritCraft 研究内联需求 |
| AI 缺失 | 证明纯写作工具在 AI 时代必须进化，WritCraft 的 AI 内联是正确方向 |
| 离线优先 | 本地文档 + 可迁移格式（Markdown）理念值得借鉴 |
| 无对话式 AI | Scrivener 无 AI 的根本原因是架构不支持——它的"对话式 AI"空白正是 WritCraft 的机会 |

---

## 七、关键引用

1. "The Scrivener app continues to be defined by its philosophy: empowering writers to think, plan, and compose without distraction." — DigitalSoftwareLabs, 2025
2. "Unlike modern AI-driven tools, Scrivener doesn't include automated writing or editing assistance." — DigitalSoftwareLabs, 2025
3. "Your writing will not be accessible by AI (unless you choose to share it outside of Scrivener)." — Cornell University LibGuides
4. "Scrivener was originally developed for fiction writing. Increasingly it is the most popular writing software among academics." — Cornell University LibGuides
5. "Scrivener's Corkboard is a powerful way to organize your projects, from brainstorming to writing to editing." — Literature & Latte 官方博客
