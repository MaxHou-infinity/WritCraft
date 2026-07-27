# 笔触 · WritCraft · V0 调研 · PDCA 复盘（项目本地）

> 项目本地目录：`/Users/maxhou/Desktop/Max 项目-2026/监控中枢/editor/`
> Wiki 同步：`~/Library/Mobile Documents/iCloud~md~obsidian/.../wiki/projects/writ-craft/`
> 完整复盘见 Nowledge Mem `writcraft-v0-pdca-2026-07-14`

> **开发阶段续作交接（2026-07-18，历史专项证据）**：调研结论不变；工程已完成三级工作区、`edit.md`、ChangeSet、完整有界 Context、项目向导、增强图谱、来源/脚注、Cursor 标签、右侧四书签和 300 文件压力基线。metrics、Research、image-01 当时通过真实 Electron 9/9 stub GUI 闭环；Main 固定主机、Renderer 双层断网、主动 abort、内部 Watcher revision 回声隔离、错误脱敏与真实 Chromium DOM sanitizer 13/13 也完成专项验证。当前总链以紧随其后的 0.0M 校准和 `v0/DEVELOPMENT-STATUS.md` 为准；仍待真实 MiniMax API、真实作者指标与发布复审，不得沿用历史测试数字或“已可发布”判断。

> **当前收口校准（2026-07-27，0.0N）**：应用内 Image Trash 已完成可见列表、逐项恢复、确认式精确快照清空、重启恢复与并发新到条目保留；五项竞态 P1 均已关闭，最终独立复审 **P0=0/P1=0/P2=1（非阻断）**。当前源码完整 `npm test`、Electron-enabled `npm run verify`、受控强制 Electron **32/32** 与 Persistent Watcher **3/3** 均通过，图片专项 **107/107**。下一步只进入 `docs/AUTHOR-ACCEPTANCE-V1-CONTRACT.md` 规定的真实 `sk-api-`、真实作者和发布验收，不再扩展 Image Trash；现有 App/ZIP 继续禁止分发。旧数字只保留为历史复盘，不可覆盖 `v0/DEVELOPMENT-STATUS.md`。

---

## P (Plan)

| # | 计划项 | 完成度 |
|---|--------|-------|
| 1 | 15 张 Kanban 卡任务图 + 依赖 | ✅ 100% |
| 2 | 14 个 brief 模板（每张 3-7KB）| ✅ 100% |
| 3 | 6 个硬约束（read_file / patch / verify / 反陷阱 / 跨卡 / 失败不掩盖）| ✅ 100% |
| 4 | 3 维预估（10 张卡 → 2.5 小时）| ✅ 实际 2 小时 |

---

## D (Do)

### 15 张卡执行顺序

```
T0 houwu       ─→ 4.4KB  T0-plan.md         (5 min)
T1-T6 houdah   ─→ 9 张平行调研          (~ 60 min)
T7 houda       ─→ 25KB  T7-analysis.md     (10 min)
T8 houliu      ─→ 17KB  T8-critique.md     (8 min)
T9 houwu       ─→ 16KB  T9-strategy.md      (8 min)
T10 housan / Max ─→ 4 份 deliverables      (主人亲自)
```

### 7 个 worker / owner 关键动作

1. **houdah** 在 25 分钟内完成 6 张调研卡（⚠️ 太快 → Pitfall H 风险）
2. **owner** 立即跑 12 项 verify，发现 Trae / Windsurf 缺失（task done 但文件不在预期路径）
3. **owner** 用 `find /Users/maxhou/Desktop -name "X.md"` 搜**整个桌面**——发现 5 个错路径目录（"中枢"被读成"中枯/中栏/中枝/中柾/中枱"）
4. **owner** mv 错路径到 `_back/`，再触发 REWORK 重做
5. **housan** 在 T10 unblock 后**自我激励创建 3 张子卡**（看到 brief 4 份 deliverables 自己分解任务）
6. **owner** archive worker 自我激励的 3 张子卡（保留我手动版本）
7. **owner** 亲自用 patch 写 T10 PRD / HTML（避免再被 worker 写错路径）

### 4 份最终交付（v2.1）

| 文件 | 大小 | 12 项 verify |
|------|------|------------|
| HTML 报告（v2.1）| 51.8KB | 15/15 ✅ |
| PRD markdown | 28.4KB | 完整 |
| CSV 矩阵 | 4.0KB | 完整 |
| V0 路线图 | 7.2KB | 完整 |

---

## C (Check)

### 5 个验收维度

| 维度 | 实测 | 通过？ |
|------|------|-------|
| 调研广度 | 38 份 raw / 7 个维度 / ~ 433KB | ✅ |
| 证据等级 | 每条结论附 A/B/C/D | ✅ |
| Wiki 双写 | 44 文件 / 42 frontmatter | ✅ 100% |
| 反陷阱沉淀 | 10 个反陷阱（1-10）| ✅ |
| 12 + 3 项 checklist | 15/15 全过 | ✅ |

### 4 个期间踩的坑（已沉淀到 skill）

| # | 坑 | 解决方式 |
|---|----|---------|
| 1 | 反陷阱 6 · patch 失败不掩盖 | read_file → patch → grep → 失败不掩盖 4 步法 |
| 2 | 反陷阱 7 · worker 写错路径 | brief 加 ASCII fallback + owner 独立 find 全桌面 |
| 3 | 反陷阱 8 · hermes 沙箱环境 | 改用 `find -print0` 范式 + `terminal(background=true)` + gateway |
| 4 | 反陷阱 9 · verify grep -c bug | 改用 `grep -o \| wc -l` 字符级 + `grep -c` 行级双验证 |

---

## A (Act)

### 已沉淀的资产

1. **Nowledge Mem** `writcraft-v0-pdca-2026-07-14`（learning 类型 / importance 0.8 / 8 个标签 / 含跨项目 SOP 1.2.0 模式）
2. **skill** `recruit-platform-integration-sop` v1.2.1
   - 增补反陷阱 6-10
   - Nowledge Mem 5 维质量标准
   - 复盘触发器 5 步
3. **max-master-profile** §Max 与 Somnia Lab 真实关系（2026-07-14 主人已退出 → 改为"前 Somnia Lab HR 顾问"）
4. **本 README**（项目级复盘）

### 下次同类项目（V0 调研 / PRD）可立即复用

- **SOP 1.2.0 模式**：T0 计划 + T1-T6 平行调研 + T7 综合 + T8 质询 + T9 战略 + T10 PRD
- **5 维质量评分**（API / 自动化 / 付费 / 数据 / 合规）作为综合分析模板
- **12 项 + 3 项 v2.1 checklist** 作为 PRD 报告验证标准
- **反陷阱 1-10** 作为任何 patch / write / verify 操作前的 mental checklist

### 历史启动条件（已完成，非当前 Next Action）

以下是 2026-07-14 调研阶段的启动假设，已被实际选型和第十二次收口覆盖：编辑器采用原生 `contenteditable`，正式 PRD 已存在，Plan Mode 可跳过。当前 Next Action 只看 `v0/DEVELOPMENT-STATUS.md` 与 `docs/AUTHOR-ACCEPTANCE-V1-CONTRACT.md`：完成真实付费 API、真实作者旅程与发布验收。

- 原 Day 1 技术试验：TipTap + M2.7 + Plan Mode 5 模板（已废止为当前入口）
- 原 Day 7 前置条件：先有正式 PRD（已完成）
- V0 Go/No-Go 仍以真实作者指标为准，见 `deliverables/笔触 · WritCraft — 一个月 V0 路线图.md`
