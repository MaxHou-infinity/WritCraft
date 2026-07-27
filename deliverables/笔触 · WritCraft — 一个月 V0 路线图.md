# 笔触 · WritCraft · 一个月 V0 路线图

> 文档版本：2026-07-27（v2.3，原生 helper 与 E2E 稳定性收口）
> 状态：**V0 续作中，完整产品未完成**；产品范围以 `docs/WRITCRAFT-PRD-V3.md` 为准  
> 2026-07-27 续作交接：既有产品链保持签字；真实作者项目预检/隔离副本已换成 bundled universal Mach-O helper。Author **42/42**、真实 API 离线合同 **15/15**、组合 **57/57、0 网络**、package **6/6**、本地 release **7/7**、完整 test/verify 与最终强制 Electron **32/32** 通过。Onboarding 旧超时已定位为 E2E watcher 静默判断缺口并通过连续聚焦复跑。下一步由作者选择合格项目和完整 `sk-api-` 执行真实旅程；ad-hoc App/ZIP 未签名公证且禁止分发，准确事实与 TODO 只看 `v0/DEVELOPMENT-STATUS.md`。
> 范围：Month 1（4 周 × 7 天 = 28 天）

---

## 一、 V0 目标

**验证 4 个核心假设（见 HTML 报告 SLIDE 11）**：

1. 写作者愿意付 199-499 元/月
2. Plan Mode "可选"是正确策略（无大纲派不排斥）
3. ⌘K 接受率 ≥ 60%（写作领域）
4. TipTap + MiniMax 全栈可集成

**30 天后** 出 V0 Go/No-Go 决策。

---

## 二、 Week 1（Day 1-7）：基础设施 + Plan Mode + ⌘K 原型

### 目标
本机启动 WritCraft，输入一段话，按 ⌘K 触发悬浮 Diff，**接受或拒绝**——这是 V0 第一个"能跑通"的端到端交互。

### 任务清单

| Day | 任务 | 验收条件 | 输出 |
|-----|------|---------|------|
| **Day 1** | 项目脚手架（Electron + IPC + M3 接入） | `npm start` 弹出 1400×900 窗口，标题"笔触 · WritCraft" | ✅ 已完成（2026-07-15） |
| **Day 2** | 基础编辑器（contenteditable + 字符计数） | 输入文字，字符计数实时 | ✅ 已完成（2026-07-15，**见注1**）|
| **Day 3** | ⌘K 改写 + ⌘L 全局对话（M3 默认）| ⌘K 选中段 → M3 改写 → 接受；⌘L → 输入 → M3 回答 | ✅ 已完成（2026-07-15，121/121 verify） |
| **Day 4** | ⌘K 重载 + Diff 侧栏面板 + ⌘L 上下文标签 + Markdown | 重载按钮工作；Diff 高亮可见（侧栏面板）；上下文标签自动切换；Markdown 渲染 | ✅ 4 项验证；⏸️ **Day 5 决策反转**（见注2）|
| **Day 5** | ⌘K **页面内 Inline Diff**（owner 关键 UX 决策）| 选中段 → ⌘K → **编辑区原位**红删/绿增 Diff → 接受/拒绝/重载 3 按钮 inline | ✅ 核心闭环完成（2026-07-15；跨段选择暂缓） |
| **Day 6** | `edit.md` 项目级 Prompt 规格 + 工作区架构设计 | PRD V3 与 Phase A 实施规格定稿；统一项目 / 文件 / 段落三级契约 | ✅ 已完成（2026-07-15） |
| **Day 7** | Phase A 工作区 + Phase B/C 首轮闭环 | 项目树、多标签、`edit.md`、revision/recovery、迁移/Watcher/搜索、ChangeSet、一致性星图 | ✅ 完整地基与首轮智能闭环（2026-07-15） |

**注 1**：原路线图 Day 2 = "TipTap 基础集成"。实测后发现 TipTap + Electron 32 + file:// 因 4 个连环坑不可行（ESM 不支持 bare specifier / importmap 路径冲突 / contextBridge 不能暴露 ES class / sandbox 决策困局）。**改用 contenteditable 方案**满足验收条件。TipTap 真实集成留到 V0 启动后引入 Vite + bundler 时一并解决。

**注 2**：Day 4 结束后，**主人 09:30 重要 UX 决策反转**——原 PRD "删除线 + 黄色高亮" 方案被推翻，**新决策 = ⌘K 改写后 inline 在编辑区内显示红绿底色 Diff**（不是侧栏浮动面板）。这是 Day 5 工作。

**注 3（2026-07-15 新架构优先级）**：单独编辑器页面不足以支撑真实长文项目。Day 6 起优先完成 Phase A 项目工作区地基：本地项目、左侧文件树、多文件切换、安全保存、根目录 `edit.md` 与迁移。完成 Phase A 后再继续原 Week 2 的跨文件 AI 功能；一致性星图按 PRD V3 的统一 Node / Edge / Evidence / Issue 模型实施。旧名 `editor.md` 停止使用，仅保留用户确认后的兼容迁移。

### Week 1 退出条件（修订）

- ✅ **Continue**：本机启动 + ⌘K 触发 + **inline Diff 接受 / 拒绝** + MiniMax 集成无报错，并批准进入 Phase A 项目工作区开发
- ⚠️ **Pivot**：Day 3 ⌘K 接受率 < 40%（用提示改写为"高亮参考"代替替换）
- ❌ **Abandon**：Day 5 inline Diff 实现失败 + M3 不可用 + TipTap 完全无法集成

---

## 三、 Week 2（Day 8-14）：⌘K 完整版 + ⌘L 全局对话

> **历史原排期，非续作 TODO**：此表是当时的目标，不逐项代表当前实现或签字；当前能力与未关闭验收只看 `v0/DEVELOPMENT-STATUS.md`。其中“2000 字真实测试”转入真实作者验收合同，不得把此表当作重新开发已签字模块的任务列表。

> **排期修订**：以下原 Week 2 功能依赖 Phase A。先完成 `docs/PHASE-A-IMPLEMENTATION.md` 的项目文件、工作区和 revision 保存契约，再实现 `@chapter`、Composer 与跨文件 ChangeSet；不得在 localStorage 单文档架构上伪造“全项目”。

> **V0 工程基线（2026-07-18，尚非退出签字）**：安全文件地基、Inline Diff、ChangeSet/撤销、来源/脚注、完整有界 Context、项目向导、增强图谱、章节 Composer、右侧四书签、300 文件压力测试和本地打包工具均已有实现。metrics、Research、image-01、Main 网络边界、Watcher 内外源隔离、真实 Chromium DOM sanitizer 13/13、long-form service E2E 与真实 Electron 9/9 已专项通过；仍缺真实 API、真实作者指标与发布复审。现有 App/ZIP 与源码不同步，历史数字不得用于当前签字。

### 目标
完成一篇 2000 字的方法论书籍章节，全程用 AI 协作——这是 V0 第一个"端到端真实使用场景"。

### 任务清单

| Day | 任务 | 验收条件 |
|-----|------|---------|
| Day 8 | ⌘K 5 快捷键（重写 / 缩短 / 扩写 / 学术化 / 通俗化） | 选中段落，5 种风格切换 |
| Day 9 | ⌘L 全局对话（@chapter 引用 + 1M context） | 问 "上一章讲了什么" → 准确回答 |
| Day 10 | M3 长文生成（章节级） | 写 2000 字章节 → M3 生成 1 段续写 |
| Day 11 | Composer 多文件（章节分解 + 任务卡片） | "写第 3 章" → 自动拆 5 个子任务 |
| Day 12 | Accept / Reject / 撤销栈 | 任何操作可一键回滚 |
| Day 13 | 真实测试：写 2000 字方法论章节 | 完整流程跑通 |
| Day 14 | Week 2 复盘 | ⌘K 接受率统计 + Week 3 计划 |

### Week 2 退出条件

- ✅ **Continue**：2000 字章节全程 AI 协作完成 + ⌘K 接受率统计可得
- ⚠️ **Pivot**：M3 长文生成质量 < 60%（降级为 ⌘K 单句改写为主）
- ❌ **Abandon**：5 名内测都不愿用 / 找不到 5 名内测

---

## 四、 Week 3（Day 15-21）：⌘R 研究 + 脚注 + 图像 + 结论溯源

> **历史原排期，非续作 TODO**：Research、来源与图像的本地/离线产品链已落地；真实 API、完整 `sk-api-` 图片质量与费用、真实作者证据按 `docs/AUTHOR-ACCEPTANCE-V1-CONTRACT.md` 验收。

### 目标
5 类来源（A/B/C/D）做一次研究 → 自动生成 30 条脚注——这是 V0 "研究内联"差异化能力跑通。

### 任务清单

| Day | 任务 | 验收条件 |
|-----|------|---------|
| Day 15 | ⌘R 来源约束研究（本地解析 + MiniMax 文本模型） | 选中引用文字 → 本地提取 PDF/文本证据 → M3 基于可见来源回答 |
| Day 16 | 自动脚注生成（APA7 / MLA9 / Chicago17） | 自动生成 3 种格式，用户选 1 |
| Day 17 | image-01 章节插图（inline） | ⌘I 选中 → 调 image-01 → 插入图 |
| Day 18 | 结论溯源 UI（每条 AI 输出标 A/B/C/D） | hover AI 输出 → 看到"结论 / 来源 / 边界" |
| Day 19 | 数据模型：Project / Chapter / Paragraph / Reference | TypeScript 类型完整 |
| Day 20 | 真实测试：方法论书籍 1 章节 | 完整跑通研究 + 脚注 + 图 |
| Day 21 | Week 3 复盘 | 4 个核心假设进度更新 |

### Week 3 退出条件

- ✅ **Continue**：30 条脚注 + 章节插图 + 结论溯源全部跑通
- ⚠️ **Pivot**：image-01 中文 prompt 质量差（用 Stable Diffusion / Midjourney 替代）
- ❌ **Abandon**：内测反馈负面 > 3 条 + 持续 2 周

---

## 五、 Week 4（Day 22-28）：10 名作者内测 + V0 价值报告

### 目标
10 名真实作者内测，出 V0 价值报告 + Go/No-Go 决策。

### 任务清单

| Day | 任务 | 验收条件 |
|-----|------|---------|
| Day 22 | 招募 10 名内测作者 | 3 短篇 + 2 长篇 + 3 方法论 + 2 学术 |
| Day 23 | 内测 onboarding（30 分钟视频 + 文档） | 10 人全部 onboarding 完成 |
| Day 24-26 | 内测期（每天记录使用数据） | 收集 ⌘K 接受率 / Plan Mode 跳过率 / 反馈 |
| Day 27 | V0 价值报告（自动生成） | 含 5 项核心指标 |
| Day 28 | V0 Go/No-Go 决策会议 | 输出 V1 路线图 |

### Week 4 退出条件（V0 整体）

- ✅ **Continue V1**（满足任一）：≥ 7/10 人每天用 ≥ 30 分钟 + ⌘K 接受率 ≥ 60%
- ⚠️ **Pivot V1**（满足任一）：Plan Mode 跳过率 > 50% + ⌘K 接受率 < 40%
- ❌ **Abandon V0**（满足任一）：< 3/10 人每天用 ≥ 30 分钟 + 封号/投诉 > 1 起

---

## 六、 风险闸门（每周复盘）

| 风险 | 触发条件 | 对策 |
|------|---------|------|
| MiniMax API 异常 | > 1 天不可用 | 立即暂停，回退到 OpenAI 临时方案 |
| TipTap 性能瓶颈 | 1 万字文档渲染 > 3s | 改用 Lexical 重写 |
| ⌘K 接受率不达预期 | < 40% | 改默认"建议"为"高亮参考"（不直接替换） |
| 内测负面反馈 | > 3 条 | 紧急复盘 + 调整 V1 PRD |
| 平台政策风险 | 任何平台 ToS 变化 | 立即重新评估 |

---

## 七、 成功度量（V0 → V1 Go/No-Go 决策矩阵）

| 指标 | 目标 | V0 实测 | 决策 |
|------|------|--------|------|
| ⌘K 改写接受率 | ≥ 60% | ___% | ≥ 60% → V1 / < 40% → Pivot |
| 每天写作时间节省 | ≥ 30% | ___% | ≥ 30% → V1 / < 10% → Pivot |
| 引用/脚注准确率 | ≥ 80% | ___% | ≥ 80% → V1 / < 60% → Pivot |
| 章节插图采纳率 | ≥ 40% | ___% | ≥ 40% → V1 / < 20% → Pivot |
| Plan Mode 跳过率 | ≤ 50% | ___% | ≤ 50% → V1 / > 70% → Pivot |
| 付费意愿 | ≥ 199 元/月 | ___元 | ≥ 199 → V1 商业化 / < 99 → 重新定位 |
| 封号/投诉 | 0 起 | ___起 | 0 → V1 / 1+ → 重审安全 |

---

## 八、 复盘节奏

- **每周日晚**：V0 Week 报告（1 页 PDF）
- **Day 28 晚**：V0 价值报告（5 页 PDF）
- **Day 30**：V0 PDCA 复盘 + 写进 skill

---

## 九、 下一步

2026-07-22 第十二次收口后，已关闭 Onboarding 当前源码 App 三项体验、Research→Changes、Inline Rewrite、Plan Strict、Graph、Metrics 与 Research Accuracy 的自动化产品链。下一步严格按 `docs/AUTHOR-ACCEPTANCE-V1-CONTRACT.md` 执行真实付费 API、完整 `sk-api-` 图片、真实 2000+ 字/5+ 章作者旅程和私有价值证据；只有其后才可重建产物、运行 `npm run release:verify` 并进入签名/公证/Gatekeeper 复审。完整 V0 通过且真实指标 Continue 后，方可进入 V1（3–6 个月）。
