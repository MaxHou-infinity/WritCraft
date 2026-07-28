# 笔触 · WritCraft（写作 IDE）

> 状态：**V0 候选原型；0.0Y worker 生命周期与构造错误脱敏已签收，真实作者/付费/正式发布门禁仍开放** · 发起方：Max
> 当前开发真相与唯一续作入口：[`v0/DEVELOPMENT-STATUS.md`](v0/DEVELOPMENT-STATUS.md)。配图现已覆盖评分、插入/保留/移入废纸篓、可见列表、单项恢复和确认式快照清空；五项竞态缺口已关闭，最终独立复审 **P0=0/P1=0/P2=1（非阻断）**。该签字尚不能替代真实 `sk-api-`/作者与发布验收；现有 App/ZIP 禁止分发。
> 下一阶段验收边界：[`docs/AUTHOR-ACCEPTANCE-V1-CONTRACT.md`](docs/AUTHOR-ACCEPTANCE-V1-CONTRACT.md) 已冻结；真实调用、作者内容与发布证据必须遵守其中的隐私和付费门禁。
> 当前停点：0.0Y 在 0.0X 可信根链基础上关闭 async-close write-after-end 和构造错误路径泄露。当前证据为 worker **18/18**、Watcher **31/31**、cross-layer **11/11**、Large **6/6**、package **8/8**、release **7/7**、全量 test/verify、Persistent **3/3**、真实 Electron **32/32**；独立复审 **P0=0/P1=0/P2=0**。后续能力审计已完成；下一本地批是超长 `edit.md` 的章节化上下文编译与 Inspector 章节披露，之后才是 Chat 多轮连续性和普通 Markdown 回收区恢复 UI。

## 2026-07-28 当前复核快照

> Research Accuracy v1 签收时完成事务顺序、watcher degraded 门禁与 Renderer recorded-but-locked 语义；该历史批次的完整 Node/verify 与强制 Electron 26/26 已通过。当前最终 Graph 韧性源码的完整边界以本节下方和状态台账为准。

> Graph 性能复验没有用单次重试绿灯覆盖失败：索引、布局、baseline 所有权、元素重挂、scene detach 与 dispatch-only 计时缺口均已进入根因修复和回归。该历史性能专项门禁等待两帧并读取实际 CSS 可见状态与 SVG 布局；同一源码无中间修改连续两次全链均为 **26/26**。当前签字项目总链是 0.0Y 的 32/32；精确证据只看状态台账。

- 项目 / 文件 / 段落三级工作区、`edit.md` Onboarding/落盘、Inline Diff、localized ChangeSet/撤销、单轮权威 Context、来源/脚注、草稿/冲突恢复、Cursor 式标签和一致性图谱均已接入；当前源码已完成 Onboarding v2 自动化产品链。这里的“恢复”不包含普通 Markdown 回收区的应用内列表/恢复入口。0.0Y ad-hoc App/ZIP 已按当前源码重建并验证，但仍不是 Developer ID/公证/Gatekeeper 发布产物，禁止分发。
- 普通 Changes、Plan→Changes 与 Graph 的本轮结构性修复已完成独立复审；模型不再回传整篇 after，而由 Main 验证局部锚点、依赖和 stopReason 后构造修改。
- Chat 已实现 project/file/selection 三种明确作用域、selection 必选、精确选区邻段、受限项目检索、正文 H1 Source locator 和 request/phase-owned Inspector/Chips；重开、折叠选区与外部文件变化都会主动取消失效请求，Main 权威 `PROJECT_CHANGED` 不再显示为普通调用失败。当前仍是单轮请求：最近对话摘要/多轮连续性尚未进入 Main-owned Context。
- `edit.md` 生成、审阅和确认落盘已签字，但当前 Context Resolver 要求 `edit.md` 在 6000 字符/18 KiB 内完整进入模型；超预算会整体阻断，尚未实现按章节保留关键约束及 Inspector 的实际使用章节披露。
- Chapter 已实现严格计划→逐块生成→Main 本地组装→整文件审阅，并把 project/target/instruction/context/pending 绑定到完整异步生命周期；no-op/provenance/result/capability 分类与确认式回收已动态固化，最终独立复审 P0/P1/P2=0。
- Onboarding v2 已签字：service **22/22**、capability **15/15**、all-or-nothing batch **22/22**；生产 Handler **11/11**、Main/preload **14/14**；Renderer state/UI 为 **8/8、11/11**，当前 dynamic 已随 0.0T 扩展为 **25/25**。Main single-flight 保证同项目并发只调用一次模型；Renderer epoch 与生命周期清理同时关闭 await→mint、mint→IPC delivery 两侧孤儿 authority 窗口。最终独立复审 P0/P1/P2=0。
- Author Evidence Metrics v1 保持签字；image 生成耗时/结果仍走八字段隐私事件，评分、三类终态和可选费用走独立私有 Image Review 证据。
- 真实作者验收预检/工作副本技术候选已签字：资格和复制来自同一权威快照；源、目标父目录和私有 stage 绑定 inode；清单在私有 stage 内提交 readiness，最终源复核后通过 parent-fd 相对 `renameatx_np(RENAME_EXCL)` 原子发布。匿名 0600 回执 fd 使 reserve stdout/status 丢失仍能恢复精确 stage；0.0U 进一步保证可观测异常替身在所有权证明前不会被修改或采纳。Author **48/48**、真实 API 离线合同 **15/15**。
- Research 已形成 Main-owned 的 Claim / Source / Boundary → 专用 Changes → History/undo 闭环；Renderer 只传 card ID 与目标范围，A–D 只是用户提供的来源元数据声明，不是 WritCraft 的事实背书。
- Research apply 已收敛为 Main 实际复用的生产事务；动态 11/11 以真实磁盘和 History 证明提交后的 stale、TTL、residual、tree 与状态迁移故障不会误报普通失败、泄漏 capability 或诱导重复确认。最终独立二审 P0/P1/P2=0。
- Research Accuracy 已签字：加入显式“主张匹配/不匹配”作者判断和私有聚合；判断提交前重验 exact authority，watcher 持续不可用会锁住项目 AI/写入，证据提交后变化会保留历史样本但锁定旧卡片。
- `image-01` 已实现安全落盘、解码尺寸/比例证明、必填 1–5 分、可选费用、插入/保留/可恢复废纸篓和项目聚合；废纸篓现可见数量/容量、逐项恢复和确认式精确快照清空，并明确长期保留、绝不后台删除。Trash Service **21/21**、Handler **7/7**、Integration **4/4**、Renderer **7/7**；path replacement、same-inode rewrite 与 committed TTL 五项 P1 已关闭，最终独立复审 **P0=0/P1=0/P2=1**。P2 仅为非协作外部 open-FD writer 的极窄通用残余；真实质量与费用仍待完整 `sk-api-`。
- Diagnostic Export v1 已接入设置页：作者先看到可能导出的完整 JSON，正文、Prompt、模型回答、Key、项目/文件名与路径均被排除；Renderer 只能回传一次性 token，Main 负责原生保存和不可覆盖写入。Service **13/13**、Handler **10/10**、Renderer **7/7**、Network boundary **15/15**，真实 Electron 已覆盖可见预览和隐私 sentinel。
- Inline 当前源码隔离 App 已完成人工预览零写入、拒绝、重载、接受、History 与 Safe Undo；Plan 生成已强制 `end_turn`、单文本块、strict JSON、错误脱敏与目标/Prompt 资源上限，独立复审 P0=0/P1=0。
- 0.0Y 当前源码已通过 `npm test`、非沙箱 `npm run verify:full`、Persistent **3/3**、强制真实 Electron **32/32**、package **8/8** 与 release **7/7**。16 MiB 请求、可信根 fd、async-close 与模块级路径脱敏均已关闭；文件选择器之前、`readdir/fs.watch` 非原子性、同 UID 持有 fd 写入及 0.0U reserve residual 仍是明确范围边界。
- Main 网络边界已固定文本/图片官方主机，加入 renderer HTTP(S)/WS(S) 双层断网、上下文 IPC 上限、owner abort、mutation generation、内部 revision/父目录回声隔离、零 POST retry、拒绝重定向、诊断 token-only 导出和错误脱敏；当前 network boundary **15/15**。
- Graph 扩展已动态覆盖 300 文件/1279 节点、cold-to-interactive、stale/三类作者纠错、failure live、键盘/AX、布局、性能、重启与 A→B；缓存完整语义权威、Renderer 不可变快照、同/跨项目异步所有权及 Unicode quote 边界已关闭，最终独立复审 P0=0/P1=0/P2=0。
- 2026-07-26 已建立本地 Git `main` 基线；后续改动必须通过提交保留可审计差异。该基线不追溯此前历史，阶段事实仍以 `v0/DEVELOPMENT-STATUS.md` 和当次可复现测试证据为准。

## 一句话定义

为"专业长文写作者"打造的 **Cursor 式 AI 写作 IDE**——结构化大纲 / 逐句悬浮修改 / 深度研究内联 / 多模态插图 / 结论溯源 / 计划模式 / 跨章引用，全部在一个界面完成。

## 核心问题

专业作者（写书 / 律师辩护状 / 医生综述 / 咨询报告 / 管理学方法论）当前写"结构化长文"时被迫在 4-5 个工具间切换：

1. **写作工具**（Notion / 飞书 / Scrivener）：支持排版，但 AI 浅
2. **对话式 AI**（ChatGPT / Claude / Gemini）：输出好，但写完一段就重置上下文
3. **研究工具**（浏览器 + 学术数据库）：可深度，但跳出 IDE
4. **代码 IDE**（Cursor / Trae）：交互体验最好，但**只懂代码，不懂结构化长文**
5. **图片 / 图表工具**（Midjourney / 即梦 / MiniMax 生图）：质量高，但生成后还要手动插

**没有**一个产品同时解决这 5 个工具的"长文写作专属需求"——这是空白市场。

## 你的 5 个硬要求（从 Max 主人原话提取）

1. **大程度参考 Cursor or Trae 的交互方式**——AI 内联、悬浮 diff、跨文件跳转、Composer 多文件编辑
2. **文档格式需要兼具写作排版、图片插入、图标插入的功能**——长文排版 + inline image + icon set
3. **内嵌 AI 功能，支持多模态和基座模型产品栈**——LLM 文本 + 图像生成 + 文档理解 + 后续可接 TTS/视频
4. **先以 MiniMax 模型入手**（主要因为有现成的生图产品）—— 文本+图像 同源厂商，对齐调用接口
5. **需要有 plan mode**——用户先做写作框架、主旨、立意的规划

## 非目标（V0 不做）

- ❌ 多人实时协作（Notion / 飞书已饱和，差异化不足）
- ❌ 出版商对接（V2 才做）
- ❌ 移动端 App（V1 之后考虑）
- ❌ 移动端 AI 语音转写 / TTS（V2 才做）
- ❌ 多语言切换（先专注中文，V2 国际化）

## 证据等级

- **A**：官方文档 / 官方帮助 / 官方开源 / 官方数据
- **B**：作者访谈 / 开源仓库 / 头部评测
- **C**：媒体报道 / 第三方测评 / 社区 Issue
- **D**：未验证推断

## 核心产品原则

1. **项目意图先于写作**——`edit.md` 定义项目主旨、目标与结构；Plan Mode 是可跳过的辅助入口，不强制所有作者先列大纲
2. **逐句可控**——AI 重写永远用 diff 呈现，用户接受/拒绝明确
3. **结论溯源**——每条 AI 输出标注"结论 / 来源 / 边界"（沿用 Max-AI 结论溯源规范）
4. **研究内联**——不跳出 IDE 完成研究、引用、生成图像
5. **多模态原生**——文本、图像、表格、引用、脚注、批注为同一等公民
6. **数据可迁移**——Markdown + JSON 双格式 export，不锁文件格式

## 调研路径（10 张 Kanban 卡 + 1 张 PRD）

```
T0 (houwu) · 调研计划分解 + 时间线
T1 (houdah) · Cursor / Trae / Windsurf 深度调研（交互 + 架构 + 收费 + 局限）
T2 (houdah) · 写作 SOP 与方法论调研（短篇 / 长篇 / 方法论 / 学术 4 类文体）
T3 (houdah) · 知名作家工作流调研（Stephen King 写作工具包 / 纳博科夫卡片法 / 麦基故事学）
T4 (houdah) · 写作软件竞品横评（Scrivener / Notion / Lex / Ulysses / Milanote / iA Writer）
T5 (houdah) · MiniMax 模型产品栈调研（M-2.7 / 图像 / 视频 / 语音 / 文档）
T6 (houdah) · 多模态 AI 编辑器设计模式研究（Monaco / TipTap / ProseMirror / Lexical）
T7 (houda)  · 综合分析（5 维评分 + 置信度 + 痛点-功能映射）
T8 (houliu) · 魔鬼质询（10 项 + 修正清单 + 金句）
T9 (houwu)  · V0 / V1 / V2 路线 + 退出条件
T10 (housan) · 完整 PRD + 价值说明 + 一个月 V0 路线 + HTML 报告
```

## 输出物

- `deliverables/笔触 · WritCraft — 产品需求与价值说明.md`
- `deliverables/笔触 · WritCraft — 四维度能力矩阵.csv`
- `deliverables/笔触 · WritCraft — 一个月 V0 路线图.md`
- `deliverables/笔触 · WritCraft — 产品定义与价值报告.html`
- 11 份 raw 调研报告 + 4 份综合分析

## PDCA 复盘纪律

- 每个 Kanban 卡跑前先 read brief，跑后 grep + wc verify
- 12 项 checklist 必过（HTML 报告）
- 重要更正写进 `raw/_source-log.md §重要更正`
- 失败 / 偏离必明确记录到 PDCA，不掩盖
