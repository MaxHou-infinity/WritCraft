# 笔触 · WritCraft · V0 调研 · PDCA 复盘（项目本地）

> 项目本地目录：`/Users/maxhou/Desktop/Max 项目-2026/监控中枢/editor/`
> Wiki 同步：`~/Library/Mobile Documents/iCloud~md~obsidian/.../wiki/projects/writ-craft/`
> 完整复盘见 Nowledge Mem `writcraft-v0-pdca-2026-07-14`

> **开发阶段续作交接（2026-07-18，历史专项证据）**：调研结论不变；工程已完成三级工作区、`edit.md`、ChangeSet、完整有界 Context、项目向导、增强图谱、来源/脚注、Cursor 标签、右侧四书签和 300 文件压力基线。metrics、Research、image-01 当时通过真实 Electron 9/9 stub GUI 闭环；Main 固定主机、Renderer 双层断网、主动 abort、内部 Watcher revision 回声隔离、错误脱敏与真实 Chromium DOM sanitizer 13/13 也完成专项验证。当前总链以紧随其后的 0.0M 校准和 `v0/DEVELOPMENT-STATUS.md` 为准；仍待真实 MiniMax API、真实作者指标与发布复审，不得沿用历史测试数字或“已可发布”判断。

> **历史收口校准（2026-07-27，0.0P）**：Image Trash 保持签字；真实作者验收预检/隔离副本已用 universal Mach-O helper 移除 `/usr/bin/python3` 运行时依赖。动态 **42/42** 覆盖单一快照、祖先/stage 身份、私有 readiness、parent-fd no-clobber 发布、精确清理、三态 committed truth、universal 架构、空 `PATH` 与 embedded-NUL 拒绝；真实 API 离线合同 **15/15**，组合 **57/57、0 网络**，package **6/6**、本地 release **7/7**、完整 test/verify 与最终强制 Electron **32/32** 通过。Onboarding 旧红灯已定位为测试只等首个 watcher 事件，补静默/fatal/CDP 门禁后聚焦真实 Electron 累计 8 次通过；最终独立复审 **P0=0/P1=0/P2=3**。Coding Plan、最近短项目和完整 `sk-api-` 仍是后续外部门禁。

> **当日工程复盘**：正确之处是先做无网络合同、只读凭据/项目资格预检、隔离副本工具和真实 CLI 回归，并在付费与隐私边界前停止；错误之处是设计时把“扫描、复制、复核、rename”当成若干顺序步骤，没有先冻结完整身份/提交状态矩阵，导致 11/11 与全链绿灯后仍一次暴露 6 个 P1。明日必须先把复审项逐条变成会失败的对抗测试，再改 service；不得继续扩测试数量或外部验收来掩盖事务协议未闭合。

> **修复复盘**：本轮先让旧实现稳定红灯，再将路径字符串事务改为 cwd/inode 绑定遍历；最终架构不再预占公开最终名称，而是在随机私有 stage 内完成写入/readiness，最终源复核后用绑定 parent fd 的相对 `renameatx_np(RENAME_EXCL)` 原子发布。复审连续发现“helper 重新解析绝对路径”“stage 创建后换壳”“primary/inspect 双报告丢失误判未提交”等问题，最终将外部 helper 固化为未提交/已提交/未知三态。测试接口、helper 回执和回滚代码都必须接受与 happy path 同等级的攻击性审查；一次全链绿灯不能替代独立复审。

> **稳定性复盘**：文件 watcher 测试不能把“队列此刻为空”或“一次 generation 已变化”当成外部事件全部结束；debounce、原生 watcher 与轮询 fallback 可能分批到达。会铸造新 capability 的 E2E 必须等待队列排空并让权威 generation 在覆盖 fallback 周期的窗口内保持稳定，同时在 timeout 输出状态快照。否则会把产品正确的 stale 保护误报为业务回归，并浪费额度在盲目复跑上。

> **发布与测试复审教训**：本轮 package/release 7/7 一度是假绿：外层 App 的 `--deep --strict` 没能证明放在 Resources 内的 helper 已签名，且 App 宣称支持 10.15、helper 实际要求 11.0。真实 Electron 32/32 也一度可能漏掉最后一条 CDP 命令后的进程/连接故障。修复原则是 nested code 移入 `Contents/Helpers` 并内到外签名，ZIP 解压后逐项验签、核对 minOS 和执行真实事务；E2E 从 spawn 起统一回收，进程 exit 与 CDP failure 都进入全局 fatal latch，并用固定 2/32 阶段数而非 `${passed}/${passed}` 自证。

> **2026-07-27 0.0Q 启动时的阶段性复盘（已被下一段收口覆盖）**：今天依次关闭 Image Trash 可靠性、真实作者隔离副本、原生 universal helper/打包验签和 E2E fatal 门禁，并启动 0.0Q。做对的是每次复审发现新 P1 都先复现、再修代码与测试、最后同步文档；做错的是曾把“1.5 秒没再变化”当作接近系统权威的证明，也一度让不同文档把下一步写成直接真实作者验收。该阶段确认时间窗只能作临时观测，并要求接完 Main-owned exact barrier；此项现已完成。所有九个当前事实入口仍须在同一里程碑横向更新，版本页首与页尾也必须反查一致。

> **2026-07-27 0.0Q 收口复盘**：Main-owned exact barrier 已替代时间静默推断，并在独立复审发现 3 个 P1 后补齐 internal-mutation epoch、首次 strict 全项目失效和 Renderer 外部同步失败门禁。做对的是保留红灯、先写对抗测试、让独立 reviewer 二审，最后以同源连续两次 32/32 收口。做错或险些做错的有三点：把“强制遍历”误当“完整 hash”（实际仍复用了轮转预算）；测试把运行时实例与不存在的 fixture 字段比较，错把测试断言红当产品红；E2E 在 Graph 外部写后仍读取已删除的 `externalQueue`，造成 3.5 秒假性能红。今后任何权威 barrier 必须证明覆盖范围而非只证明动作发生；集成红灯先核对运行时 authority 与测试 fixture；删除生产同步原语时同步搜索并删除所有测试侧旧等待。当前保留 P2 是 strict hash 的 `lstat→path read` TOCTOU，明日优先用 no-follow fd + fstat 关闭。

> **2026-07-28 0.0T Plan 时序复盘**：首次 15 秒 Plan write timeout 不能靠后续绿灯关闭。代码审计发现 Workspace 已从磁盘安装 tree/current/History 并清除恢复 marker，Changes 却又等待第二轮重复 refresh 才发布“已安全写入”终态；磁盘真相已提交，界面却被非权威 IPC 拖住。正确做法是先用永久 pending refresh 让旧实现确定性红，再以 `authoritativeReloaded` 作为唯一跳过条件，并为普通、Research residual-unavailable、Onboarding 当前非 edit 三条分支补 fault injection。E2E 同时拆开“接受”和“应用”，失败只导出阶段、计数、耗时与磁盘哈希。教训是：提交后的终态必须由已安装的权威真相驱动；额外刷新可以是后续观察，不能成为已提交操作的成功门槛。完整绿灯之后仍须独立复审覆盖每个共享分支。本批最终 P0/P1/P2=0。

> **2026-07-28 0.0U reserve 复盘**：`mkdirat` 成功但尚未 `openat` 时，事后 `fstat/fstatat` 只能证明“当前路径与 fd 一致”，不能证明“这个目录就是本次创建的对象”。旧 helper 更严重的问题是先 `fchmod` 再检查，导致外来 0755 替身被修改并采纳。红测用测试专用进程稳定跨过该 syscall 窗口；修复删除预所有权写入，并只读验证身份、0700、euid 与空目录，同时保持 setgid 父目录兼容、移除 `st_nlink==2` 文件系统假设。可复用教训：没有原子返回 fd 的创建原语时，随机名和事后检查只能降低风险，不能伪造所有权证明；先关闭可观察副作用，再明确接受或通过权限架构改变 residual，避免反复“多加一次 stat”造成额度与时间浪费。本批 Author 48/48，独立复审 P0=0/P1=0/P2=1。

> **2026-07-28 0.0W native hash 请求预算收口复盘**：0.0V 的 5000 文件/64 MiB 只约束候选内容，深路径与完整祖先 identity 仍可让 Main 先构造大 metadata payload。正确红测不是只看最终字符串大小，而是证明 `MAX_REQUEST_BYTES` 不存在并要求“边界内成功、首条超限在加入数组前失败”；实现以 JS/C 同一 16 MiB 上限累计 header、item 与 LF，native 超限输出 batch-level `BUDGET`，Main 终止该 worker。独立复审确认资源 P2 已关闭，只指出协议注释漏列新终态；补齐后二审 P0=0/P1=0。最终 worker **12/12**、Watcher **30/30**、cross-layer **11/11**、Large **6/6**、package **8/8**、release **7/7**、完整 test/verify、Persistent **3/3**、Electron **32/32**，复审 **P0=0/P1=0/P2=1**。可复用教训：资源上限必须在累积结构之前检查，并在协议两端按完全相同的字节定义执行；注释也是内部协议合同的一部分。唯一 watcher P2 是初始根路径外层祖先竞态。

> **2026-07-28 0.0X 可信根 fd 项目根链复盘**：旧实现即使保护了项目内部祖先，Main 首次 `open(rootPath)` 仍会重新解析可变的项目外层祖先。红测在 Main 捕获身份后替换外祖先，旧实现稳定为 worker 12/13、`false !== true`。修复把 fd 3 改成可信 `/`，绝对项目路径只以有界十六进制启动记录进入 native；helper 逐段 no-follow 绑定所有外层组件，每个 batch 前后重走，漂移以 batch-level `ROOT` 整体失败，原链恢复后同一 worker 可重试。worker **15/15**、Watcher **31/31**、全量、Persistent **3/3**、Electron **32/32**、package **8/8**、release **7/7** 通过；沙箱 GUI 的 `code=null/SIGABRT` 由批准环境相同命令 exit 0 证明为环境限制。独立复审 P0=0/P1=0/P2=2：await 后 close 复检和模块级路径脱敏仍需红测关闭。可复用教训：关闭一个旧 P2 不等于新实现零边界；文档必须同时写清“已关闭范围”和“新发现 P2”，不能让版本推进把复审缺口藏掉。

> **2026-07-28 0.0V watcher 祖先遍历收口复盘（历史；metadata P2 已由 0.0W 关闭）**：只验证最终叶子 fd 不足以发现“祖先换壳后仍暴露同一个 hardlink 叶子”；根因是路径解析权威仍交给可变祖先。实现把扫描时的每级祖先 identity 私存，由第二个 native helper 从绑定项目根 fd 逐段 `openat`、读后重走，并把两个 helper 绑定到同一 source→signed build→App→标准 `unzip` ZIP 证据链。旧 package 单-helper合同先确定性红后修复；首次真实 Electron 又暴露开发态误用 `resourcesPath`，改为仅 packaged (`!process.defaultApp`) 取包内 helper。独立首轮复审发现 malformed helper identity 会从 EventEmitter 逃逸，现已捕获为协议失败；同时补齐扫描根/worker 根 identity 比对和安全 open flags 不可用时显式拒绝。最终 worker **10/10**、Watcher **30/30**、cross-layer **11/11**、Large **6/6**、package **8/8**、release **7/7**、完整 test/verify、Persistent **3/3**、Electron **32/32**，当时独立复审 **P0=0/P1=0/P2=2**。教训是：开发态和打包态资源路径必须各自验证；任何子进程 stdout 都是不可信输入，EventEmitter 内解析必须 catch 后 fail-closed。

> **2026-07-27 0.0R 收口复盘（历史，已由 0.0S 覆盖）**：strict watcher hash 已从 path stream 改为 `O_NOFOLLOW | O_NONBLOCK` fd，在扫描时私存 BigInt identity，读前后 `fstat`、返回前 `lstat`，并按已验证 size 有界读取；最终文件组件被 symlink、普通文件替换、增长或同 inode 改写时均 fail-closed，不再签发成功 barrier。做对的是先用 scan→open 对抗测试稳定复现，再分离私有纳秒权威与公开 `mtimeMs` 兼容语义，并补成功/失败 fd close；Watcher **28/28**、跨层 **11/11**、同源完整 Electron 连续两次 **32/32**。险些做错的是把内部精度升级直接暴露到公开 snapshot，造成旧舍入语义回归；今后安全精度升级必须与公开兼容字段分层。保留 P2 仅为纯 Node 无法逐段 `openat` 保护祖先目录，不能宣称全路径 TOCTOU 已消除。当时的下一本地任务和未重建产物状态均已由下方 0.0S 覆盖。

> **2026-07-28 0.0S 收口复盘（历史，已由 0.0T 覆盖 Plan timing）**：先把 reserve 回执和构建因果各写成会失败的反证：没有 0600 receipt 的 reserve 必须在创建 stage 前失败；App helper 被篡改、ZIP 携带旧 helper 或 build 产物替换都必须拒绝。实现让 helper 写入 Main 持有的匿名回执 fd，stdout/status 丢失时仍恢复精确身份；build 在 attestation 前签 helper，package 只复制/校验，App 与标准 `unzip` ZIP 同比同一 hash，并比较完整 bundle tree（含 symlink 与 POSIX mode）。release 还拒绝伪造产品、版本、Developer ID 或已公证状态。Author **47/47**、离线 **15/15**、package **8/8**、release **7/7**、`npm test`/verify exit 0。当时首次 Plan write timeout 不能被随后两次同源 **32/32** 覆盖，因此保留为 timing P2；该项现已由上方 0.0T 的确定性根因测试与修复关闭。当时祖先 `openat`、`mkdirat→openat` 微窗口及外部门禁仍开放；native reserve residual 后由 0.0U 明确接受，祖先项已由上方 0.0V 关闭到绑定项目根以下范围，真实作者/付费/正式发布门禁仍开放。ad-hoc App/ZIP 只作历史本地证据，禁止分发。

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
