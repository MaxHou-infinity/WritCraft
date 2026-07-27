# 笔触 · WritCraft · V0 调研 · PDCA 复盘（项目本地）

> 项目本地目录：`/Users/maxhou/Desktop/Max 项目-2026/监控中枢/editor/`
> Wiki 同步：`~/Library/Mobile Documents/iCloud~md~obsidian/.../wiki/projects/writ-craft/`
> 完整复盘见 Nowledge Mem `writcraft-v0-pdca-2026-07-14`

> **开发阶段续作交接（2026-07-18，历史专项证据）**：调研结论不变；工程已完成三级工作区、`edit.md`、ChangeSet、完整有界 Context、项目向导、增强图谱、来源/脚注、Cursor 标签、右侧四书签和 300 文件压力基线。metrics、Research、image-01 当时通过真实 Electron 9/9 stub GUI 闭环；Main 固定主机、Renderer 双层断网、主动 abort、内部 Watcher revision 回声隔离、错误脱敏与真实 Chromium DOM sanitizer 13/13 也完成专项验证。当前总链以紧随其后的 0.0M 校准和 `v0/DEVELOPMENT-STATUS.md` 为准；仍待真实 MiniMax API、真实作者指标与发布复审，不得沿用历史测试数字或“已可发布”判断。

> **当前收口校准（2026-07-27，0.0P）**：Image Trash 保持签字；真实作者验收预检/隔离副本已用 universal Mach-O helper 移除 `/usr/bin/python3` 运行时依赖。动态 **42/42** 覆盖单一快照、祖先/stage 身份、私有 readiness、parent-fd no-clobber 发布、精确清理、三态 committed truth、universal 架构、空 `PATH` 与 embedded-NUL 拒绝；真实 API 离线合同 **15/15**，组合 **57/57、0 网络**，package **6/6**、本地 release **7/7**、完整 test/verify 与最终强制 Electron **32/32** 通过。Onboarding 旧红灯已定位为测试只等首个 watcher 事件，补静默/fatal/CDP 门禁后聚焦真实 Electron 累计 8 次通过；最终独立复审 **P0=0/P1=0/P2=3**。Coding Plan、最近短项目和完整 `sk-api-` 仍是后续外部门禁。

> **当日工程复盘**：正确之处是先做无网络合同、只读凭据/项目资格预检、隔离副本工具和真实 CLI 回归，并在付费与隐私边界前停止；错误之处是设计时把“扫描、复制、复核、rename”当成若干顺序步骤，没有先冻结完整身份/提交状态矩阵，导致 11/11 与全链绿灯后仍一次暴露 6 个 P1。明日必须先把复审项逐条变成会失败的对抗测试，再改 service；不得继续扩测试数量或外部验收来掩盖事务协议未闭合。

> **修复复盘**：本轮先让旧实现稳定红灯，再将路径字符串事务改为 cwd/inode 绑定遍历；最终架构不再预占公开最终名称，而是在随机私有 stage 内完成写入/readiness，最终源复核后用绑定 parent fd 的相对 `renameatx_np(RENAME_EXCL)` 原子发布。复审连续发现“helper 重新解析绝对路径”“stage 创建后换壳”“primary/inspect 双报告丢失误判未提交”等问题，最终将外部 helper 固化为未提交/已提交/未知三态。测试接口、helper 回执和回滚代码都必须接受与 happy path 同等级的攻击性审查；一次全链绿灯不能替代独立复审。

> **稳定性复盘**：文件 watcher 测试不能把“队列此刻为空”或“一次 generation 已变化”当成外部事件全部结束；debounce、原生 watcher 与轮询 fallback 可能分批到达。会铸造新 capability 的 E2E 必须等待队列排空并让权威 generation 在覆盖 fallback 周期的窗口内保持稳定，同时在 timeout 输出状态快照。否则会把产品正确的 stale 保护误报为业务回归，并浪费额度在盲目复跑上。

> **发布与测试复审教训**：本轮 package/release 7/7 一度是假绿：外层 App 的 `--deep --strict` 没能证明放在 Resources 内的 helper 已签名，且 App 宣称支持 10.15、helper 实际要求 11.0。真实 Electron 32/32 也一度可能漏掉最后一条 CDP 命令后的进程/连接故障。修复原则是 nested code 移入 `Contents/Helpers` 并内到外签名，ZIP 解压后逐项验签、核对 minOS 和执行真实事务；E2E 从 spawn 起统一回收，进程 exit 与 CDP failure 都进入全局 fatal latch，并用固定 2/32 阶段数而非 `${passed}/${passed}` 自证。

> **2026-07-27 日终复盘**：今天依次关闭 Image Trash 可靠性、真实作者隔离副本、原生 universal helper/打包验签和 E2E fatal 门禁，并启动 0.0Q。做对的是每次复审发现新 P1 都先复现、再修代码与测试、最后同步文档；做错的是曾把“1.5 秒没再变化”当作接近系统权威的证明，也一度让不同文档把下一步写成直接真实作者验收。日终已纠正：时间窗只能作临时观测，明日必须接完 Main-owned exact barrier；所有九个当前事实入口须在同一里程碑横向更新，版本页首与页尾也必须反查一致。

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
