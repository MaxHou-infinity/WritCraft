# WritCraft 项目综合评估报告

> 评估日期：2026-08-16
> 评估方式：5 个并行独立 agent，分维度评审（前端 / 后端 / 项目结构 / 测试质量 / 安全可靠性），每个维度独立精读源码与测试，全部发现带 `文件:行号` 证据；跨维度结论已交叉核对。
> 评估对象：`/Users/maxhou/Desktop/Max 项目-2026/监控中枢/editor`（WritCraft · Electron AI 写作 IDE）
> 边界声明：全部为静态评审 + 少量无副作用抽样实测（`node --check`、2 个纯逻辑测试、1 次 `npm audit`）；未运行 `npm test` / `npm run verify:full`，未触发真实 API 调用。

---

## 1. 项目基线

| 项 | 数值 |
|---|---|
| 技术栈 | Electron 43（darwin/arm64+x64）、原生 JS（无框架）、CommonJS、8 个 native C helper |
| 规模 | main 116 文件 / 72,626 行；renderer 47 文件 / 18,653 行；shared 7 文件 / 1,621 行；native C 约 24,215 行 |
| 测试 | 220 个 `verify-v0-*.js` / 89,282 行（比源码还多）；51 个 0.4 清册 + 169 个 legacy 基线，磁盘↔清册零漂移 |
| 依赖 | 仅 electron / diff / pdfjs-dist 3 个生产依赖；shrinkwrap 锁 28 包；`npm audit --omit=dev` 实测 0 漏洞 |
| 工程状态 | 153 提交；0.1.2 → 0.2.0 → 0.3.0（已发 npm preview）→ 0.4.0 Stage A / A1b（**NO-GO**） |
| 工作树 | 143 个未提交变更（111 未跟踪 + 31 修改 + 1 删除）——Stage A 中间态，无中间提交 |

---

## 2. 总体结论

**综合评分：8.0 / 10（良好偏上）** ｜ 一句话结论：**这是一套"防御纵深 + 契约治理"都达到专业级水准的单人桌面项目，无 P0 阻断；主要失分在"装配未闭环"（A1b 三个红灯属实）、"自动化兜底缺失"（无 CI/lint/统一语法门禁）与"单体膨胀 + 仓库卫生"三类问题上。**

| 维度 | 评分 | 一句话结论 |
|---|---|---|
| 安全与可靠性 | **9.0** | 本地单用户应用的安全纵深教科书级：渲染隔离、IPC 全通道 sender 校验、路径/symlink 三重防线、native fd+dev/ino 身份校验、崩溃恢复 fail-closed；无 P0/P1 |
| 测试与质量体系 | **8.0** | fault-injection 专业级、清册注册零漂移、真实 API 三重隔离；但完全依赖人工纪律，无 CI/lint/统一 `node --check` 兜底 |
| 前端（渲染层） | **8.0** | 无框架约束下罕见地同时做到严格 schema 校验、每次 await 后的竞态防护、12 处 innerHTML 全部净化、强测试文化 |
| 后端（主进程） | **8.0** | 事务/恢复（held-fd + inode 身份 + digest 链 + 双槽 CAS journal + O_NOFOLLOW C helper）接近教科书级；但 A1b mixed 出口在装配层未接线、main.js 膨胀、capability 层有契约不一致 |
| 项目结构与工程治理 | **7.5** | 治理骨架罕见：文档权威分层 + 测试契约门禁 + 原生构建/发布验证三件套；失分在仓库卫生（tgz/乱码目录/二进制入库）与冻结合同漂移 |

**P0（阻断）：0 条**。五个维度均未发现可静默破坏数据、越权写项目外路径、绕过事务权威或导致任意代码执行的可达路径。

**P1（严重）：13 条**（其中 2 条是状态文档已披露的 Stage A 红灯，经独立代码定位全部证实；1 条为新发现的真实功能 bug）。

---

## 3. 各维度明细

### 3.1 安全与可靠性 —— 9/10（无 P0/P1）

**优点（五星级防线）**
- 渲染进程隔离到 Electron 安全上限：`contextIsolation+sandbox`（main.js:1837-1841）、CSP `script-src 'self'; connect-src 'none'`（index.html:6）+ session 级 `onBeforeRequest` 掐断全部 http/https/ws + 窗口导航/弹窗/权限全拒（main.js:1845-1881）。
- IPC 全通道校验：103 个 handler + 2 个 sendSync 通道全部经 `assertTrustedSender`（main.js:1659-1666）。
- 路径三重防线：`validateRelativePath`（拒绝双平台绝对路径/`..`/`\0`）、`resolveInside` 逐段 lstat 反 symlink、`assertPublicMarkdownPath` 白名单（project-service.js:77-137）。
- native C helper：fd 化操作 + dev/ino/mode 身份核对 + 有界解析，无 `system/popen`，5/8 文件零 strcpy。
- API key：0600 原子落盘 + fsync + 读取时强制权限校验 + 拒 symlink（api-key-config-service.js:64-107）；全库无 key/prompt/文档内容日志。
- 可靠性：single-flight mutation lease、watcher 事件延迟排空、崩溃恢复标记 fail-closed、workspace 保存单调 generation 防旧写入、AI 请求前后 origin 双重校验、snapshot 恢复 O_NOFOLLOW + 身份核对。
- 供应链：3 个生产依赖 + shrinkwrap 完整性哈希 + `npm audit` 实测 0 漏洞。
- 测试证据真实：`dom-sanitizer` 用真实 Electron 灌入 active 元素/SVG/DOM clobber/javascript: 链接逐项断言中和。

**P2 加固（6 条）**
- API key 明文 0600 落盘，未用 Keychain（符合作者声明威胁模型，建议中优先级迁移）。
- 安全验证脚本多为静态正则（network-boundary/process-boundaries），重构易漂移，建议补行为级用例。
- preload 2 处 `sendSync`（workspace-save-seed / save-workspace-before-close）。
- CSP `style-src 'unsafe-inline'`（编辑器需要，维持现状可接受）。
- 仓库卫生：根目录 `writ-craft-0.2.0.tgz`、node_modules 残留 shrinkwrap 外依赖树。
- Electron 8 周升级节奏需例行化。

### 3.2 测试与质量体系 —— 8/10

**优点**
- fault-injection 跨真实生产边界且验证"承诺语义"：changes-history-recovery 829 行 24 场景（fsync 注入、partial-write + rollback 精确还原、symlink 攻击 fail-closed）；research-apply-transaction 用 Proxy getter 故障注入；real-finalize-restart 全真实装配丢响应后从磁盘重建收敛。
- 0.4 清册注册门禁无死区：220/220 全分类，任何新增/改名脚本不注册则 `npm test` 失败（check-v0-0-4-test-registration.js:114-120）。
- 真实 API 三重安全隔离：`WRITCRAFT_REAL_API_ACCEPTANCE` 未设则 exit 2 fail-closed，0 网络调用，image 额外付费门。
- 断言验证真实行为（错误码/行号/offset/上限溢出计数）；88 个脚本用 mkdtemp + finally 清理。
- 渲染层双轨测试：`onboarding-renderer-dynamic.js`（1195 行）用 vm 执行真实源码 + 自注册检查。

**P1（4 条）**
1. **E2E 强制门语义失效**：6 个 electron 脚本（ai-task-progress/unified-writing-task/author-cross-entry/author-affected/context-catalog/api-key-restart）命中 skipReason 时无条件静默跳过，`WRITCRAFT_E2E_FORCE=1` 形同虚设；对照 3 个脚本正确实现了 `unavailable && !FORCE` 才跳。
2. **`npm test` 默认链漏跑 DOM sanitizer**（安全敏感路径，只在 preverify）。
3. **两个真实 worker 零执行覆盖**：`workspace-inventory-worker.js`、`daily-workspace-data-worker.js` 从未被任何测试加载，测试只注入 fake WorkerClass。
4. **无 lint / 无 CI / 无统一 `node --check` 入口**：16 个 src 文件（含 `main.js`、`preload.js`、`project-service.js`）与 17 个测试文件缺 `'use strict'`；语法与风格健康无机器保障。

**P2 代表**：门禁链复制粘贴维护（posttest==postverify 逐字节重复）；唯一死区 `verify-v0-day3.js` 不在任何 npm 脚本；`changes-review-ux.js` 全文件 123 行纯字符串断言（假红/假绿）；`author-acceptance-preflight.js:1036` 向仓库 cwd 写垃圾文件不清理；覆盖盲区（workspace-state-service 无直接测试、daily-workspace-view/project-home-view/citation-identity/edit-prompt-manifest 无测试引用）；0.4 Stage-A 39 个测试不在默认链（设计使然，无 CI 时易漏跑）。

### 3.3 前端（渲染层）—— 8/10

**优点**
- 三条架构红线全量 grep 核实未突破（无 require/fetch/XHR/WebSocket/process）；47+7 文件全过 `node --check`。
- 全部 12 处 `innerHTML` 逐一核对无未净化路径（marked 输出必经 escapeMarkdownSource + sanitizeFragment，editor.js:1375-1376）。
- 事务层是真状态机：inline-rewrite/changes-proposal/research-handoff 等，schema 正则 + 状态转移表 + token 所有权。
- 竞态防护到每次 await 后（generation 计数 + owner.isCurrent + ai-request-guard 快照比对）。
- 测试文化强：15 个渲染层测试约 5000 行，含源码提取 + vm 混验、script 顺序断言。
- 纠偏：`legacy-draft.js` 有真实调用（workspace.js:2638-2641），**不是**死代码；死代码是 `diff-renderer.js`（`__diffRender` 无读取方）与 `window.__editorEl`。

**P1（3 条）**
1. **上帝文件 + 手工 script 编排**：`workspace.js` 3322 行 / `changes-view.js` 2712 / `editor.js` 1908；index.html:1381-1428 手工排序 48 个全局 script 标签（顺序错误即运行时炸）。
2. **无全局错误处理 + 82 处 `catch(_)` 静默吞异常**：错误被吞后状态与 UI 不同步，无观测面。
3. **130 处跨模块直读共享可变状态** `window.__workspace.state.*`（workspace.js:3318 整体导出 state），模块边界形同虚设。

**P2（10 条）代表**：`createFile`/`moveFile` 未用已定义的 `isPublicMarkdownPath` 做路径校验（workspace.js:2764/991-1038）；原生 confirm/prompt 与自建 dialog 割裂；`beforeunload` 异步 IPC 火忘（workspace.js:3226）；`getStableText` 每次克隆整个编辑器 DOM（editor.js:73-96）；`exactKeys` 5 份重复；a11y/i18n/魔法数字细节。

### 3.4 后端（主进程）—— 8/10

**优点**
- IPC 安全纵深完整（assertTrustedSender + sandbox + 权限全拒 + preload 白名单 + watcher-flush 屏障协议）。
- hostile 输入校验到达 descriptor 级（Reflect.ownKeys 精确键集合、拒 getter/setter、拒稀疏/超长数组）。
- "持有即验证"恢复模型：fstat 捕获 dev/ino/size/nlink/mode/mtimeNs/ctimeNs，读前读后反复比对。
- Journal CAS 链完整：双槽 A/B 帧 + generation 递增 + digest 自校验 + assertTransition 状态机。
- clear() 失败自愈：目录 fsync 失败原样重写 terminal marker 保持锁；ACK 丢失重发 marker 作重试钥。
- C helper 无命令行注入面、逐组件 openat 防 symlink（project-hash-helper.c:393-507）。
- 依赖方向干净（Main 零 renderer import）、错误消息白名单收敛、诊断导出 128KiB 上限。
- 无 console.log 泄漏、无 TODO/FIXME。
- **独立验证了状态文档的 3 个 P1 红灯全部属实**（非照抄）。

**P1（3 条）**
1. **A1b mixed 事务出口未接线**：`main.js:366-374` 创建 changesHistoryTransaction 时未传 `existingRestoreLifecycle`，mixed（EXISTING+MISSING）在 `changes-history-transaction.js:265-281` 必抛 `SNAPSHOT_RESTORE_EXISTING_LIFECYCLE_UNAVAILABLE`——Stage A 核心出口在当前装配下**不可达**。
2. **Journal 物理绑定仍双权威**：`public-markdown-native-lifecycle.js:511-521/932-954` 仍走 legacy `markerFd` 通道；`snapshot_restore_undo` 未 journal-backed（reconciliation:4565-4570），EXISTING/undo 路径仍挂旧 marker。
3. **新发现功能 bug**：`writing-navigation-store.js:342-345` 对重复 acquire 会 `terminateAction`（取消第一次在途的模型调用/写入并清空租约）——渲染器响应丢失后按同 attemptId 重试会被"自杀式"取消，合法操作误杀且无恢复路径。

**P2（约 28 条）代表**
- `writing-structure-transaction-service.js:379-384` 全仓库唯一无 timeout 的 spawnSync，helper 挂死将**永久冻结主进程**。
- `markdown-trash-helper.c:513-515` 无长度校验的 strcpy（同 UID 篡改 journal 可栈溢出，正常流程不可达但 C 侧必须独立校验）。
- `main.js` 4759 行膨胀（103 个 handler 内联注册）；`writing-navigation-provider-adapter` 与 `projectCallLLM` 重复实现同一权威；纯 JS journal 与 C journal 双实现三处同步。
- chat IPC 错误契约不一致（`writcraft:chat` 无顶层 try/catch，异常以 rejected promise 逃逸，与其余 `{ok:false}` 不一致）；commit 错误路径泄漏会话租约。
- capability 层：pending-changeset 只绑 rootPath 不绑 projectInstanceId；delivery-capability 缺 ownerId；snapshot-capability ID 可预测；writing-structure-capability 无容量上限。
- 网络层：先读 body 再判 `response.ok` 导致错误分类失真；**零自动重试**（429/5xx/超时一次性失败）；image 外部取消误报"超时"；validateApiKey 无格式白名单（与 minimax 不一致）。
- watcher：`emit()` 未 try/catch；flush 全量 hash 与读取路径耦合；同毫秒同 size 漏检窗口。
- 217 处 `catch(_) {}`（多数合理，但 main.js:229/1494 吞错可能留下不一致状态）。
- 测试证据分级未固化（fake journal adapter 的绿灯可能被引用为持久化证明）。

### 3.5 项目结构与工程治理 —— 7.5/10

**优点**
- 测试清册契约门禁是全仓库最强治理装置（实测 220 = 基线 169 + 门禁 51 零漂移，且已接入 pretest/preverify 链首）。
- `docs/INDEX.md` 单一导航入口 + 派工权分层（"哪些文档可派工"讲得比多数公司 wiki 清楚）；全仓库 0 真实断链。
- `DEVELOPMENT-STATUS.md` 控制块 52 行一屏可读；详细轮次已归档。
- 原生构建/发布验证三件套生产级：`-Werror` 严格编译、arm64+x86_64 通用、sha256 attestation、verify-release 逐一对账。
- 依赖面极小且自洽；无密钥/凭证入库（.env.example redacted + 0600）；gitignore 基本有效。

**P1（3 条）**
1. **构建产物入库**：`v0/writ-craft-0.2.0.tgz`（668KB）被 git 跟踪且文件名与当前版本脱节，是 `.git` 膨胀到 47MB 的成因之一；gitignore 无 `*.tgz/*.zip` 规则。
2. **垃圾目录入库**：`raw/_back/` 18 个编码损坏命名的重复文件（"监控中枢"乱码变体），污染仓库且 `git add -A` 会继续拖入。
3. **冻结合同被当当前合同活改**：`CHANGES-HISTORY-RECOVERY-V1-CONTRACT.md`（+513 行未提交）头部已加"0.4.0 Snapshot extension under Stage A review"，同一文件同时承担"0.1.2 冻结记录"与"0.4.0 当前权威"双角色；`EVIDENCE-DELIVERY-V1-CONTRACT.md` 命名 `-V1-CONTRACT` 却属当前 0.4.0 合同——与"`*-V1-CONTRACT` = 冻结"的命名约定冲突，INDEX 层级导航会得到错误权威映射。

**P2 代表**：巨型脚本链（test=2942 字符/63 引用、verify=3243 字符/71 引用、posttest==postverify 逐字重复）；8 个编译二进制 Mach-O 进 git（与 .c 源漂移无法在 review 中发现）；执行控制文档（0.4.0-EXECUTION-PROTOCOL / A1B-EXISTING-STATE-MATRIX）未跟踪、checkout 即丢失；3 个孤儿文档 INDEX 定位不到；110KB 状态归档放在 v0/ 根而非 docs/archive/；4 个空壳目录；提交规范小违规（1 条无 type + 3 条 release:）；package.json:51-52 缩进错乱；`overrides.markdown-it` 死配置；双 LICENSE 字节不一致。

---

## 4. 跨维度共性问题（多份报告独立命中，优先级最高）

1. **质量体系无自动化兜底**（质量 P1-4、结构 P2-1、后端 P2-30/31）：无 CI、无 lint、无统一 `node --check` 入口；测试注册靠清册门禁强约束，但语法/风格/门禁链一致性完全靠 AGENTS.md 文化。四个 agent 独立得出同一结论。
2. **门禁链手工复制粘贴维护**（质量 P2-1、结构 P2-1）：`test`/`verify`/`pre*`/`post*` 巨型单行脚本链，`posttest==postverify` 逐字节重复，pretest/preverify 已漂移（仅差 dom-sanitizer）。
3. **0.4 主战场不在默认链**（质量 P2-8、结构 P2-3）：39 个 Stage-A 测试只由 `verify:0.4:stage-a-components` 运行且不在 `npm test`/`verify` 内，无 CI 时靠人工显式执行，易漏跑。
4. **仓库卫生三连**（结构 P1-1/P1-2、安全 P2-5）：tgz 入库、乱码目录入库、编译二进制入库、node_modules 残留。
5. **两端单体膨胀**（后端 P2-1、前端 P1-1）：main.js 4759 行 + workspace.js 3322 行，是最大的可维护性债。
6. **静默吞异常成风**（前端 P1-2 82 处、后端 P2-30 217 处）：多数为尽力而为但缺观测面，关键路径吞错会留下状态不一致。
7. **门禁语义与关闭时序两类坑**（质量 P1-1、前端 P2）：E2E FORCE 门失效 + beforeunload 异步 IPC 火忘——"测试门禁"与"实现时序"两端同时存在相似的模式问题。
8. **契约命名与事实漂移**（结构 P1-3、质量 P2-8）：冻结/当前合同混淆、组件证据/边界证据未分级——文档与测试的证据语义都需要"分级标签"。

---

## 5. 行动清单（按优先级）

### 第一批：立即（1-2 天内，低风险高收益）
1. **修 `acquireAction` 重试自杀**（后端 P1-3）：`writing-navigation-store.js:342-345` 重复获取只拒绝不 abort；补"响应丢失后按同 attemptId 重试"测试。
2. **仓库卫生清理**：`git rm --cached v0/writ-craft-0.2.0.tgz`；删除 `raw/_back/`（先 diff 确认无独有内容）；gitignore 补 `*.tgz/*.zip/*.app`；修 package.json:51-52 缩进；`git diff --check` 纳入提交流程。
3. **E2E 强制门统一**（质量 P1-1）：把 skip 判定收敛为 `unavailable && !FORCE` 才跳的单例 helper，6 个失效脚本全部改用。
4. **`npm test` 补 dom-sanitizer**（质量 P1-2）：pretest 末尾追加 `verify-v0-dom-sanitizer.js`。
5. **补 spawnSync timeout + C strcpy 守卫**（后端 P2-11/P2-32）：`writing-structure-transaction-service.js:379-384` 补 10s timeout；`markdown-trash-helper.c:513-515` 等 4 处 strcpy 加 `strlen < sizeof` 守卫。
6. **测试 cwd 副作用清理**（质量 P2-5）：`author-acceptance-preflight.js:1036` 写入目标改临时目录并在 finally 清理。

### 第二批：checkpoint 关闭时（0.4.0 Stage A 出口）
7. **接通 A1b 装配**（后端 P1-1/P1-2）：`main.js:366-374` 传入 `existingRestoreLifecycle`（复用 public-markdown-native-lifecycle.js:1568-1629 的 existingRestore 作用域），补 mixed 生产纵切 fault-injection 测试；journal 单权威化（EXISTING 走 existingTerminalPublication CAS、undo 补 journal-backed、删 legacy markerFd 通道）——闭合状态文档 3 个红灯。
8. **冻结合同拆分**（结构 P1-3）：0.1.x 冻结部分进 `docs/archive/contracts/`，0.4.0 扩展成独立当前合同；同步修正 INDEX"当前详细合同"与命名例外。
9. **执行控制文档先落库**（结构 P2-3）：0.4.0-EXECUTION-PROTOCOL 与 A1b 矩阵在 checkpoint 开启时即提交；Stage A 实现按可独立测试切片做中间提交，避免 140+ 文件单发提交。
10. **0.4 门禁显式化**（质量 P2-8）：README/DEVELOPMENT-STATUS 固定"0.4 组件门禁执行清单"；引入 CI 时首个 job 跑 `verify:0.4:registration` + `verify:0.4:current-components`。

### 第三批：中期迭代（1.0 / 0.5 前）
11. **落地最小自动化质量门**（质量 P1-4）：eslint（strict/单引号/分号/kebab-case）+ `verify:syntax`（遍历 `node --check` 全仓 js）+ pre-commit hook；有 CI 时 `verify:0.4:registration` 作为必跑 job。
12. **真实 worker 集成测试**（质量 P1-3）：为两个 worker 各加 1 个 spawn 真实 Worker 的断言。
13. **拆单体**（前端 P1-1、后端 P2-1）：`workspace.js` 按领域拆分（目标 <1500 行/文件）；`main.js` 按域外移 handler（目标 <2500 行）。
14. **渲染层全局错误观测**（前端 P1-2）：统一错误总线，`catch(_)` 至少记入诊断；收敛 130 处直读 `window.__workspace.state.*`（前端 P1-3）。
15. **capability 一致性收敛**（后端 P2-12~15）：pending-changeset 补 projectInstanceId、delivery 补 ownerId、snapshot ID 改随机、writing-structure 加容量上限。
16. **网络层韧性**（后端 P2-17/18）：先判 `response.ok` 再读 body；429/5xx/超时加 2-3 次指数退避重试；修 EEXIST→REFERENCE_EXISTS 映射。
17. **门禁链去重**（质量 P2-1、结构 P2-1）：抽 `verify:post-common` 公共子链；写静态断言校验 posttest==postverify、pretest⊆preverify、无悬空/死区脚本。
18. **API key 迁移 Keychain**（安全 P2-1）：native 加 keychain-helper.c，JSON 降级为缓存；同步更新威胁模型文档。
19. **处理死区与盲区**（质量 P2-2/P2-7）：`verify-v0-day3.js` 接入链或显式退役；workspace-state-service 补直接单测；确认 citation-identity/edit-prompt-manifest 是死代码还是需测试。

### 维持不动（真正的资产，任何改动保留其行为）
- `check-v0-0-4-test-registration.js` 清册契约门禁（含 Stage A 不得自签完成、GUI 不得进默认门）。
- `docs/INDEX.md` 派工权分层与 `DEVELOPMENT-STATUS.md` 控制块。
- build-native-helper / package-macos / verify-release 三件套（sha256 attestation）。
- CSP + vendored marked 的零网络依赖策略。
- 渲染隔离 + IPC sender 校验 + 路径/symlink 防线的实现方式。
- fault-injection 测试体系（fsync 注入、Proxy 故障、真实 C helper 编译验证）。

---

## 6. 附录：各维度完整报告要点索引

| 维度 | 评分 | 核心证据锚点 |
|---|---|---|
| 结构 | 7.5 | check-v0-0-4-test-registration.js:114-120；INDEX.md:5-48；writ-craft-0.2.0.tgz；raw/_back/；CHANGES-HISTORY-RECOVERY-V1-CONTRACT.md（+513 行） |
| 质量 | 8.0 | changes-history-recovery.js（829 行 24 场景）；6 个 electron 脚本 FORCE 门失效；workspace-inventory-worker.js 零覆盖；package.json:36-37/80-81 |
| 安全 | 9.0 | main.js:1659-1666/1837-1881；project-service.js:77-137；api-key-config-service.js:64-107；npm audit 0 漏洞 |
| 前端 | 8.0 | workspace.js:3322 行；index.html:1381-1428；82 处 catch(_)；130 处 state 直读；editor.js:1375-1376 |
| 后端 | 8.0 | main.js:366-374；changes-history-transaction.js:265-281；writing-navigation-store.js:342-345；public-markdown-native-lifecycle.js:511-521；writing-structure-transaction-service.js:379-384 |

> 生成方式：5 个独立子代理并行静态评审 + 交叉核对；抽样实测：`node --check` 全量 renderer/shared、`verify-v0-block-anchor.js` 7/7、`verify-v0-citation-formatter.js` 10/10、`npm audit --omit=dev` = 0 漏洞。本报告为评估快照，不构成 0.4.0 签收依据。
