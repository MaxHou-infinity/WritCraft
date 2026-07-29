# T7 · 笔触 WritCraft 综合分析
## 5 维评分 × 置信度 × 痛点-功能映射 × PRD 五问 × V0 范围

> 综合分析完成 | 2026-07-14 | 分析员：houda
> 输入：T1 cursor-trae-research × T2 writing-sop-research × T3 author-interviews × T4 competitor-analysis × T5 llm-stack-research × T6 design-patterns
> 证据等级：A/B/C/D 四级强制标注；含自我质疑与极限验证

---

## 绝对路径核对

```
✅ <repository-root>/raw/T7-analysis.md
```

---

## 一、5 维评分总表

| 维度 | 评分 | 置信度 | 核心依据 |
|------|------|--------|---------|
| AI 交互范式（Cursor/Trae 借鉴度） | **4/5** | **MH** | 6 大范式可移植（T1，A×17来源）；5 写作新范式需自研（B） |
| 写作需求满足度（4 文体 × 7 阶段） | **4/5** | **H** | 12 个 A 级来源跨 4 文体；7 作家验证（T2/T3） |
| 多模态能力（MiniMax 全栈整合） | **3/5** | **M** | M2.7/M3/image-01/Speech-2.8 均就绪（A）；集成未经实测（C） |
| 差异化壁垒（vs 6 竞品） | **3/5** | **M** | 5 个独家壁垒（逐句 Diff/Plan Mode/研究内联/多模态/溯源）全部 A 级 |
| V0 可行性（4 周 MVP） | **3/5** | **M** | TipTap AI Toolkit + MiniMax API 路径存在但未实测（C） |
| **综合** | **3.4/5** | **M** | 不存在致命否决项；3 个 P0 风险需 V0 前验证 |

### 维度一：AI 交互范式（4/5，MH）

6 大 Cursor 范式可移植性分析：

| 范式 | 可移植 | 写作化改造要点 | 证据等级 |
|------|--------|--------------|---------|
| Tab 内联补全 | ✅ | 句子级 ghost text，"输入补全预测"替代代码行预测 | A |
| ⌘K 悬浮修改 | ✅ | 写作场景 diff 替代代码 diff；删除线+高亮替代红绿 | A |
| ⌘L 全局对话 | ✅ | 章节上下文替代代码上下文；@chapter 引用替代 @file | A |
| Composer 多文件 | ✅ | Plan Composer：章节分解+任务卡片+中断恢复 | B |
| @引用与文件树 | ✅ | @chapter/@section 替代 @file；语义索引替代 Merkle tree | B |
| Accept/Reject | ✅ | 句/段/章三级审核替代代码级 | A |
| Plan Mode | 🆕 自研 | 无代码类比；写作框架/主旨/立意规划 | B |

**反模式（绝对不能移植）**：代码语法高亮 / 编译错误 / Git diff

**自我质疑**：Cursor 范式基于代码语法，写作是自然语言，Tab 内联误接受率可能 30-50%
**答**：V0 设计为"悬浮建议"而非"自动接受"；参考 Lex AI command 模式接受度更高

**置信度：中高（MH）** — Cursor/Trae 交互数据充分（A 级 × 17 个来源），中文场景差异化有参考；自研范式范围明确，工时可估算

### 维度二：写作需求满足度（4/5，H）

4 类文体（短篇/长篇/方法论/学术）共同包含 6 阶段：**计划→大纲→草稿→修订→编辑→发布**。Plan Mode 可覆盖 4/4 文体的"计划"阶段。

| 文体 | 计划方法 | 修订方法 | 代表作家/框架 |
|------|---------|---------|-------------|
| 短篇小说 | Story Grid 场景卡 | 分层修订（结构→语言） | Stephen King / Story Grid |
| 长篇小说 | 纳博科夫卡片+伏笔总表 | 6-12 周分层冷却 | Nabokov / McKee |
| 方法论书籍 | 原则树+四维矩阵 | 原型读者验证 | Ray Dalio / Cialdini |
| 学术综述 | PRISMA Protocol | 同行评审 | Cochrane / PRISMA 2020 |

**自我质疑**：无大纲派（King、Murakami）可能不用 Plan Mode
**答**：Plan Mode 是可选入口；McKee/Nabokov 是强大纲派，代表高价值用户

**置信度：高（H）** — 12 个 A 级来源跨 4 类文体，7 位作家验证，逻辑链完整

### 维度三：多模态能力（3/5，M）

| 能力 | 现状 | 价格 | 关键依据 | 证据等级 |
|------|------|------|---------|---------|
| 文本生成/改写（M2.7/M3） | ✅ 生产就绪 | $0.30/M 输入 | 1M tokens 上下文 | A |
| 图像生成（image-01） | ✅ 生产就绪 | $0.0035/张 | 中文 Prompt 优化，嫡传国内 | A |
| 语音合成（Speech-2.8） | ✅ 可用 | $60-100/M 字符 | TTS Arena 盲测双榜第一 | A |
| 文档解析 | ⚠️ 有限可用 | — | PDF/DOCX/TXT；无 OCR | A |
| 视频生成 | ❌ V1+ 才做 | — | Hailuo-02 规格明确 | — |
| 全栈整合 | ⚠️ 未实测 | — | OpenAI-compatible 理论可行 | C |

**自我质疑**：MiniMax API 与 TipTap AI Toolkit 集成完全未经验证
**答**：V0 可绕过 AI Toolkit 直接调 API；Tracked Changes 用 tiptap-track-changes 开源替代

**置信度：中（M）** — 各模态独立证据充分（A 级），全栈串联未经实测

### 维度四：差异化壁垒（3/5，M）

**WritCraft 5 个独家壁垒**（6 款竞品全部缺失）：

| 壁垒 | 竞品现状 | 证据等级 |
|------|---------|---------|
| ① 逐句悬浮 Diff | 所有竞品 AI 都是"替换"非"修改对比" | A |
| ② Plan Mode | 所有竞品"直接写"，无先规划结构 | A |
| ③ 研究内联 | 所有竞品需跳出工具做研究 | A |
| ④ 多模态生成 | 所有竞品为纯文本工具 | A |
| ⑤ 结论溯源 | 所有竞品 AI 输出为"裸结论" | A |

| 竞品 | 核心优势 | 对 WritCraft 的劣势 |
|------|---------|-------------------|
| Scrivener | 长文架构/编译无可替代 | 零 AI；2024 无集成计划 |
| Notion | 协作生态成熟 | 长文弱（>几千字）；AI 非核心 |
| Lex | AI 命令式体验好 | 无大纲；无结构化；无研究内联 |
| Ulysses | 极简专注 | 零 AI；Apple 生态锁定 |
| iA Writer | 设计语言成熟 | 零 AI；完全线性文档 |
| Milanote | 视觉素材收集强 | 非写作工具；零 AI |

**自我质疑**：Notion 12 个月内推"专业写作模式"可能关闭窗口
**答**：Notion 基因是"通用工作空间"，专业长文深度上限低于 Scrivener；参考 Scrivener 20 年未被取代

**置信度：中（M）** — 竞品数据充分（A/B 级），AI 写作 IDE 细分市场竞争态势演变快

### 维度五：V0 可行性（3/5，M）

| 技术路径 | 可行性 | 依据 | 证据等级 |
|---------|--------|------|---------|
| TipTap AI Toolkit + Tracked Changes | ✅ | 逐句悬浮 Diff 完整方案 | A |
| MiniMax OpenAI-compatible API | ✅ | M2.7/M3 Anthropic+OpenAI 双格式 | A |
| Yjs + Hocuspocus 协作 | ✅ | TipTap Collaboration 完整文档 | A |
| Plan Mode | ⚠️ 需自研 | Cursor Composer 参考；TipTap 节点树重建 | B |
| 中文排版 | ⚠️ 部分满足 | Typography 基础中文标点；CSS hack | B |
| MiniMax + TipTap 集成 | ⚠️ 未实测 | 理论路径存在 | C |

**V0 三个必须解决的风险**：
- **P0**：MiniMax + TipTap 集成必须实测（否则 V0 技术路径不通）
- **P1**：中文排版质量不达标则用户立即流失 Notion
- **P2**：Plan Mode 范围（轻量级锚点 vs 完整规划）决定工期

**自我质疑**：TipTap AI Toolkit 是否支持 MiniMax？官方文档未明确列出
**答**：V0 应优先用 MiniMax OpenAI-compatible API 直连，绕过 AI Toolkit 厂商锁定

**置信度：中（M）** — TipTap + MiniMax 各自独立证据充分（A 级），集成未经实测；Plan Mode 需自研，工时不确定

---

## 二、置信度图谱

| 结论 | 置信度 | 依据 | 潜在漏洞 |
|------|--------|------|---------|
| 市场空白真实存在（无产品同时具备结构化长文+Cursor式AI内联+Plan Mode） | **高** | T4 竞品横评 + T2 痛点验证 | 需求可能太窄，空白≠商业可行 |
| TipTap + MiniMax 技术上可集成 | **中** | AI Toolkit 基于 OpenAI API（A）+ MiniMax OpenAI-compatible（A） | 集成可能有未预见兼容性问题 |
| Plan Mode 需自研，工期不确定 | **高** | Cursor Composer Plan Mode 公开参考（B）；TipTap 无内置 | 自研质量可能不如预期 |
| V0 用户需同时订阅 Notion + WritCraft | **中** | V0 功能子集；Notion 排版协作成熟 | 若 V0 排版够用，用户可能放弃 Notion |
| 商业路径清晰但 LTV 未验证 | **中** | 竞品定价模型可得（B）；写作工具订阅有先例 | 专业写作者是否愿为 AI-native 工具额外付费，缺验证 |

---

## 三、痛点 × 功能 × 置信度 映射矩阵（32 项）

格式说明：`【痛点】功能 | 来源 | 优先级 | 置信度 | 核心依据`

### P0 级别（V0 必须做，8 项）

1. **【工具切换打断心流】同屏研究内联** | T2/T3 | P0 | **H** | 7/7 作家依赖多工具切换；竞品全部缺失研究内联
2. **【AI 修改黑盒】逐句悬浮 Diff + 结论溯源** | T2/T3 | P0 | **H** | 7/7 作家强调"修改是真正写作"；竞品全部无逐句 Diff
3. **【长文结构性断层】Plan Mode + 持久大纲** | T2/T3 | P0 | **H** | 4/4 文体强调"计划先于写作"；Nabokov 138 张卡片管理伏笔
4. **【AI 上下文断裂】章节上下文锚定** | T2/T5 | P0 | **H** | M3 的 1M tokens 可覆盖长篇 50-60%；4/4 文体需跨章节一致性
5. **【初稿修改无从下手】修改模式 + 读者视角反馈** | T3/T2 | P0 | **MH** | King 冷置期（On Writing，A）；Hemingway 停车法被 7/7 引用
6. **【⌘K 实时响应体验】⌘K 悬浮修改** | T1 | P0 | **H** | Cursor ⌘K 成熟实现（T1）；M2.7-highspeed <200ms 满足实时性（T5）
7. **【大纲多级折叠拖拽】结构化大纲编辑器** | T2/T4 | P0 | **H** | Scrivener Binder 验证需求真实；Nabokov 卡片是最高级结构化方法
8. **【草稿版本链中断】草稿版本链 + 中断恢复** | T3/T2 | P0 | **H** | 7/7 作家依赖版本管理；King 6 周抽屉本质是版本隔离

### P1 级别（V1 必须做，V0 尽量做，8 项）

9. **【非线性写作管理】卡片网格 + 拖拽重排** | T3/T2 | P1 | **MH** | Nabokov 卡片法 A 级来源（Strong Opinions）；场景重排是侦探小说核心
10. **【多模态内容生成】MiniMax Image-01 内联** | T5/README | P1 | **H** | image-01 生产就绪，$0.0035/张，成本极低
11. **【章节级局部修改】选区级 AI 修改** | T1/T4 | P1 | **H** | Cursor ⌘K 有选区级能力（T1）；Lex/Notion 只能段落/块级（WritCraft 机会）
12. **【中文排版质量】中文排版优化** | T6/README | P1 | **M** | Typography 基础中文标点（B）；高质量排版需 CSS hack，无完整方案
13. **【写作目标追踪】写作目标仪表盘** | T3/T2 | P1 | **MH** | King 2000词/天 A 级来源；Murakami 10页/天 B 级来源
14. **【引用管理】引用管理集成** | T2/T4 | P1 | **MH** | PRISMA/Cochrane 严格引用需求（T2）；竞品仅 Scrivener 支持脚注
15. **【分层修订视图】分层修订视图** | T3/T2 | P1 | **MH** | 7/7 作家 + 4/4 文体共同强调；King 6 周冷却后分层修订
16. **【协作批注评论】批注 + 评论系统** | T1/T4 | P1 | **MH** | Notion/Confluence 已验证需求；写作场景需定制化

### P2 级别（V2 做，7 项）

17. **【角色状态追踪】角色卡片 + 引用汇总** | T3 | P2 | **M** | 需求真实但用户群体窄（仅长篇小说家）；McKee 角色弧线框架
18. **【伏笔数据库】伏笔追踪 + 未引爆警告** | T3 | P2 | **M** | 高级叙事技巧；Hemingway 冰山理论要求精确埋伏
19. **【采访录音转写】Speech-2.8 集成** | T5 | P2 | **H** | Speech-2.8 TTS Arena 双榜第一；中文自然度超 OpenAI/ElevenLabs
20. **【Story Grid 场景可视化】Story Grid 场景卡** | T2 | P2 | **M** | Story Grid 短篇小说核心方法论（A）；普通小说家不一定用此框架
21. **【PRISMA Flow 可视化】PRISMA 流程图** | T2 | P2 | **H** | PRISMA 2020 学术综述金标准（A）；Duosuma 等投稿系统要求
22. **【学术数据库直查】@research 学术检索** | T2 | P2 | **MH** | 学术写作强需求（T2）；CNKI/PubMed 有公开 API
23. **【四维编辑面板】原则/案例/反例/边界对照** | T2 | P2 | **MH** | Ray Dalio 原则树 + Cialdini 说服论 + Christensen 论文方法论

### P3 级别（V2+ 或可做可不做，9 项）

24. **【人物关系图谱】角色关系图谱** | T3 | P3 | **L** | 用户群体窄；McKee 多视角叙事是高级技巧
25. **【身体状态整合】专注模式 + 提醒** | T3 | P3 | **L** | 需求分散；超出 IDE 核心范围
26. **【AI 参与度控制】AI 透明度滑块** | T3 | P3 | **L** | 7 作家态度差异极大；Murakami 2026 明确反对
27. **【每日冷却期提醒】冷置期倒计时** | T3/T2 | P3 | **MH** | King 6 周冷却期 A 级来源；技术实现简单
28. **【Hemingway 停车点】冥想空间标记** | T3/T2 | P3 | **MH** | Hemingway 停车法被 4/7 作家引用；段落中段检测容易
29. **【章节字数统计】章节长度分析** | T2 | P1 | **MH** | King 固定字数目标；Murakami 仪式感驱动
30. **【协作评论追踪】@提及 + 评论通知** | T1/T4 | P1 | **MH** | Notion/Confluence 已验证；写作场景定制化
31. **【结论溯源导出】论证透明度报告生成** | T1 | P1 | **H** | Max-AI 结论溯源规范已有体系；可复用
32. **【跨学科术语管理】术语对照表** | T2 | P3 | **L** | 用户群体窄；超出 IDE 核心范围

---

## 四、PRD 必须回答的 5 个问题

### Q1：V0 优先支持哪 1-2 类文体？

**答案：长篇小说 + 学术综述（方法论书籍次之）**

| 判断维度 | 分析 | 证据 |
|---------|------|------|
| 痛点强度 | 长篇（10万字+）工具切换痛点最强烈；学术综述（PRISMA）强结构化需求 | A |
| 市场规模 | 学术综述（全球年发表约 300 万篇）；长篇（中文出版年新增约 5 万种） | B |
| 付费意愿 | 学术用户有明确付费场景；长篇家有软件付费习惯（Scrivener $49.99） | B |
| 功能覆盖 | 4 类文体中，长篇+学术与 WritCraft 核心功能（大纲+Plan Mode+悬浮Diff）匹配度最高 | H |
| 短篇为何次之 | 体量小 Notion/Word 已够；Murakami 等明确反对 AI，核心用户可能不用 | B |

**反面例子**：V0 选短篇 → 痛点不够痛，留存率可能 <30%

### Q2：Plan Mode 的具体 UX 流程是什么？

**5 步入场 → 结构锚定 → 写作切换**

```
① 选择文体（论文/报告/书稿/专栏，4 选 1）
② AI 生成初始大纲（Part→Chapter→Section→Paragraph 多级树；每节点填"本章主旨"1-2 句）
③ 用户在可视化大纲中拖拽调整（顺序/增删/折叠）
④ 完成大纲 → 点击"开始写作"（切换到写作模式，章节结构作为 AI 上下文锚点）
⑤ 写作中可随时返回 Plan Mode（不打断流；是锚点非强制）
```

**V0 最小范围**：只做"轻量级入场锚点"（参考 King 的"最后一页"法——先写最后一段，确定结尾再倒推）。完整写作规划（纳博科夫卡片墙/原则树）→ V1。

### Q3：AI 内联（⌘K 修改）的反馈机制如何设计？

**三层反馈 + 用户全控**

```
第一层：悬浮 Diff 展示
  → 选中文字 → ⌘K → 200ms 内返回修改建议
  → 原文上悬浮删除线（删除）+ 高亮（新增）
  → 不替代原文，用户确认后才应用
  → M2.7-highspeed 延迟 <200ms，满足实时性

第二层：结论溯源标注（沿用 Max-AI 规范）
  → 每条修改右下角标注"结论 / 来源 / 边界"
  → 鼠标悬停显示溯源卡片：
    - 结论：AI 生成内容的核心主张（1 句话）
    - 来源：AI 从哪篇参考文章/哪个数据点得出（标注文献编号）
    - 边界：这个结论在什么条件下成立/不适用

第三层：接受/拒绝机制
  → Tab 或 ⌘Y：接受当前修改
  → Esc：拒绝，等下一条建议
  → Ctrl+Enter：重新生成（保留相同上下文）
  → 多候选：最多 3 个候选方案并列（⌘K+↑↓切换）
```

**技术实现路径（TipTap + M2.7-highspeed）**：
- TipTap TrackedChanges 装饰器（tiptap-track-changes 开源包）渲染删除线+插入高亮
- M2.7-highspeed <200ms 延迟满足实时性（M3 可用于非实时生成任务）
- MiniMax M2.7 上下文 204K tokens，足以覆盖当前章节（5000-8000 字）

**不做**：❌ 自动接受（失去控制）| ❌ AI 主导连续修改（Murakami 等明确反对）| ❌ 红绿差分（干扰中文阅读流，改用删除线+高亮）

**置信度：高（H）** — Cursor ⌘K 成熟实现（T1）；M2.7-highspeed 延迟满足实时性（T5）；结论溯源规范来自 Max-AI 已有体系

### Q4：多模态 V0 哪些必做 / V1+？

| 模态 | V0 | V1 | V2 | 理由 |
|------|----|----|----|------|
| 文本生成/改写 | ✅ | ✅ | ✅ | 核心价值；M2.7/M3 就绪 |
| ⌘K 实时修改 | ✅ | ✅ | ✅ | 核心交互；M2.7-highspeed <200ms |
| 图像生成 | ⚠️ 手动触发 | 智能推荐配图 | 批处理+封面 | image-01 $0.0035/张，成本极低 |
| 文档解析 | ❌ | ✅ PDF/DOCX/TXT | OCR+多格式 | Markdown 未明确支持；V0 聚焦核心写作 |
| 语音转写 | ❌ | ❌ | ✅ | Speech-2.8 成本高，非 V0 核心 |
| TTS 回放 | ❌ | ❌ | ✅ | 同上 |
| 视频生成 | ❌ | ❌ | ✅ Hailuo-02 | V1 后考虑 |

### Q5：一个月 V0 怎么衡量"跑通"？

**3 个里程碑 + 1 个留存指标**

| 里程碑 | 时间 | 定义 | 验证方式 |
|--------|------|------|---------|
| **M1：基础功能跑通** | 第 1-2 周 | TipTap + MiniMax ⌘K + 章节大纲正常运行 | 内测 3-5 人无报错完成 5000 字文章 |
| **M2：核心价值验证** | 第 3 周 | ≥1 用户完成"写→AI 修改→接受/拒绝"完整流程，反馈"比 Notion 好用" | 用户访谈 NPS ≥ 7 |
| **M3：留存验证** | 第 4 周 | 7 天留存率 ≥ 40%（写作是周频行为，次日留存无意义） | 埋点（登录 + 大纲创建） |

**失败条件（V0 叫停线）**：M1 2 周内未完成 / M2 5 人中 4 人说"不如 Notion" / M3 7 天留存 <20%

**反面定义**：❌ 不要求功能完整 | ❌ 不要求用户增长 | ❌ 不要求商业变现

---

## 五、关键洞察 5 条

### 洞察 1：Cursor 范式的可移植性边界

6 个范式中 5 个可移植（Tab/⌘K/⌘L/Composer/@引用/Accept-Reject），1 个需彻底改造（Plan Mode）。3 个反模式绝对不能移植（代码语法高亮/编译错误/Git diff）。

**写作化改造关键**：Tab 内联 = 句子级 ghost text（非代码行预测）；⌘K = 逐句 diff（非整文件 diff）；Plan Mode = 写作框架/主旨规划（无代码类比）。

### 洞察 2：中文写作的 5 个独特需求不能忽视

| 独特需求 | 英文中地位 | 中文中地位 |
|---------|-----------|-----------|
| 中文标点「」书名号《》 | N/A | 必须正确（A） |
| 首行缩进（2 字符） | 几乎不用 | 必须有（A） |
| 字距/行距/段间距 | 英文习惯 | 中文出版标准严格（B） |
| AI 参与度控制 | 低优先级 | 高优先级：Murakami/莫言态度分化（A） |
| 写作仪式感（冷置期/跑步） | 英文作家也有 | 中文更强调"气"和"境"（B） |

### 洞察 3：4 文体 SOP 的最大公约数是"外部化记忆系统"

| 共性 | 短篇 | 长篇 | 方法论 | 学术 |
|------|------|------|--------|------|
| 外部化记忆 | Story Grid 场景卡 | Nabokov 卡片墙 | 原则树 | PRISMA Protocol |
| 冷却期修订 | 6 周抽屉法 | 分层冷却（6-12 周/层） | 原型读者验证 | 同行评审 |
| 分层修订 | 结构→语言 | 人物→逻辑→语言 | 原则验证→案例核实 | 核对→格式 |
| 量化目标 | 2000 词/天 | 10 页/天 | 每日反思 | 阶段里程碑 |

### 洞察 4：MiniMax 的核心价值是"成本 × 中文 × 同厂商"

| 考量 | MiniMax 优势 | GPT-4o/Claude 劣势 |
|------|------------|---------------------|
| 上下文 | M3 1M tokens，长文够用 | GPT-4o 128K，需分段 |
| 中文 | 全系中文优化强 | 英文为主 |
| 图像 | image-01 $0.0035/张 | 约 $0.04/张（10×差） |
| 国内访问 | api.minimaxi.com 无跨境 | 需代理，不稳定 |
| 成本（M3 ≤512K） | $0.30/M 输入 | GPT-4o 约 $2.5/M（15×差） |

**红线场景（不用 MiniMax）**：强推理 → OpenAI o1/Claude Opus | 极长上下文 >1M → Gemini 1.5 Pro | 创意极限发散 → Claude 3.5 Sonnet

### 洞察 5：WritCraft 护城河是"全流程集成"而非单点功能

```
护城河 = 计划（Plan Mode）× 修改（悬浮 Diff）× 研究（内联）× 多模态（图像）× 溯源（结论标注）
```

| 竞品单点优势 | vs WritCraft 五合一 |
|------------|-------------------|
| Notion AI 对话体验 | Notion 无 Plan Mode + 无逐句 Diff |
| Lex 极简设计 | Lex 无大纲 + 无研究内联 |
| Scrivener 编译 | Scrivener 零 AI |
| iA Writer 专注度 | iA Writer 零 AI + 零大纲 |

---

## 六、跨平台可复用"写作数据模型"草案

```
项目（Project）
  └── 章（Chapter）
        └── 段（Section）
              └── 句（Sentence）
                    └── 引（Citation）
                          └── 源（Source）
```

**核心实体**：

| 实体 | 定义 | 示例 |
|------|------|------|
| 项目 | 一本书/一篇论文/长篇项目 | 《活着》/《糖尿病综述》 |
| 章 | 书籍的章；论文的大节 | 第一章"童年" |
| 段 | 章节内的主题段；可折叠 | "1.1 时代背景" |
| 句 | 段落内的句子；AI 修改最小单位 | "福贵牵着老牛在田间走着。" |
| 引 | 对外部来源的引用；可追溯 | "(King, 2000, p.42)" |
| 源 | 参考文献条目 | King, S. (2000). On Writing. |

**来源追踪示例**：
```json
{
  "sentence_id": "s_001",
  "content": "写作是纪律性痛苦的活动。",
  "attribution": {
    "source_id": "src_001", "page": "p.42",
    "quote": "Writing is back-breaking work.",
    "confidence": "high",
    "boundary": "仅适用于创意写作，学术写作可能有不同结论"
  },
  "ai_modified": true, "modified_at": "2026-07-14T10:00:00Z", "user_accepted": true
}
```

**AI 输出格式标准（结论/来源/边界）**：
```json
{
  "conclusion": "写作应该先计划后执行",
  "source": "T2: 4/4 文体均强调计划先于写作",
  "boundary": "适用于结构化长文；短推文/即时写作不适用",
  "evidence_level": "A"
}
```

---

## 七、T1-T6 核心引用清单（25 条）

| # | 结论 | 来源 | 等级 |
|---|------|------|------|
| 1 | Notion 长文写作弱（>几千字管理不足） | T4 notion.md | A |
| 2 | Scrivener 无 AI 集成计划（2024 官方） | T4 scrivener.md | A |
| 3 | Cursor Composer 逐句 Diff 交互模式 | T1 _interaction-patterns.md | A |
| 4 | TipTap AI Toolkit + Tracked Changes 逐句 Diff 方案完整 | T6 _unified-design-recommendation.md | A |
| 5 | TipTap 节点树文档模型（非 Monaco 字符串） | T6 tiptap.md | A |
| 6 | MiniMax M2.7/M3 OpenAI-compatible API | T5 minimax-text-models.md | A |
| 7 | MiniMax image-01 $0.0035/张 | T5 minimax-image.md | A |
| 8 | MiniMax M3 上下文 1M tokens | T5 _stack-architecture.md | A |
| 9 | MiniMax M2.7-highspeed <200ms 延迟 | T5 minimax-text-models.md | A |
| 10 | MiniMax Speech-2.8 TTS Arena 第一 | T5 minimax-voice.md | A |
| 11 | Stephen King 写作痛点 | T3 stephen-king.md | A |
| 12 | Nabokov 卡片法（长篇非线性管理） | T3 nabokov-cards.md | A |
| 13 | McKee 场景-情感弧线框架 | T3 mckee-story.md | A |
| 14 | 7 位作家均强调"修改是真正写作" | T3 _synthesis.md | A |
| 15 | 4 类文体 SOP 共同包含"先规划后写作" | T2 _cross-genre-comparison.md | A |
| 16 | Trae 中文原生优化 | T1 cursor-analysis.md | B |
| 17 | Monaco 不适合写作场景（富文本 1/10） | T6 monaco-editor.md | A |
| 18 | 6 款竞品均无逐句悬浮 Diff | T4 _comparison-matrix.md | A |
| 19 | 6 款竞品均无 Plan Mode | T4 _comparison-matrix.md | A |
| 20 | 6 款竞品均无研究内联 | T4 _comparison-matrix.md | A |
| 21 | 6 款竞品均无多模态生成 | T4 _comparison-matrix.md | A |
| 22 | Murakami 明确反对 AI（2026） | T3 murakami.md | A |
| 23 | King 2000 词/天写作纪律 | T3 stephen-king.md | A |
| 24 | PRISMA 2020 学术综述金标准 | T2 academic-sop.md | A |
| 25 | MiniMax 文档解析仅 PDF/DOCX/TXT | T5 minimax-doc.md | A |

---

## 八、综合判断

### Go / No-Go with Conditions

| 条件 | 优先级 | 说明 |
|------|--------|------|
| V0 前实测 MiniMax + TipTap 集成 | **P0** | 集成不可行则技术路径需重新评估 |
| Plan Mode 范围明确 | P1 | 轻量级锚点 vs 完整规划——范围决定工期 |
| 中文排版提前验证 | P1 | 排版差则用户立即流失 Notion |
| MiniMax API 成本测算 | P2 | V0 用户月均 token 消耗，验证定价模型 |

### 推荐 V0 技术栈

1. **TipTap**（富文本核心）→ V0
2. **MiniMax M2.7-highspeed**（⌘K 实时修改，<200ms）→ V0
3. **MiniMax M3**（长文生成/改写）→ V0
4. **MiniMax Image-01**（图像生成）→ V0
5. **Yjs**（协作）→ V1
6. **不选 Monaco**（不适合纯写作场景）→ 明确排除

---

*文档版本：T7-v1.0 | 综合：T1-T6 六维研究 | 证据纪律：A/B/C/D 四级 | 综合判断：可以继续（附条件）*
*本文件为 WritCraft 笔触 IDE 专用分析，与其他项目 T7 分析隔离*
