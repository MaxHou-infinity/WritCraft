# 笔触 · WritCraft · V0 开发状态与续作入口

> 最后更新：2026-07-28（Asia/Shanghai，0.0W native hash 请求预算独立复审签收）
> 当前状态：**V0 候选原型。0.0W 已为 native project-hash 协议增加 JS/C 一致的 16 MiB 序列化请求总字节上限，关闭 0.0V 的 metadata 资源上限 P2；最终复审 P0=0/P1=0/P2=1。真实付费图片、真实作者旅程和正式发布验收仍缺，因此不得写成 V0 或发布完成。**
> 发布判断：**仍禁止分发。当前 ad-hoc App/ZIP 已从 0.0W 当前源码重建并通过 package/release 校验，但仅是本地证据，不是 Developer ID 签名、公证或 Gatekeeper 验收产物。当前仍为 Coding Plan，合同禁止调用 `image-01`；最近项目也不满足 5 章/2000 字/来源门槛。**
> 下一本地任务：**冻结 0.0X 初始项目根链绑定合同：从可信文件系统根 fd 逐段验证项目根外层祖先，避免 `fs.openSync(rootPath)` 首次按路径解析留下的 TOCTOU；项目路径不得进入 Renderer、日志或证据。readdir/fs.watch 原子性及同 UID 已持有 fd 写入不在该关闭范围。**
> 当前工作树证据：**native project hash worker 12/12、Project Watcher 30/30、cross-layer 11/11、Large 6/6、package 8/8、release 7/7；完整 `npm test` 与沙箱外 Electron-enabled `npm run verify` exit 0，Persistent Main/IPC 3/3，强制真实 Electron 32/32。双 universal helper 已按当前 source→signed build→App→标准 `unzip` ZIP 哈希链重建。独立最终复审 P0=0/P1=0/P2=1。**
> 本批保留红灯：**新增深路径批量回归先稳定红于 `MAX_REQUEST_BYTES` 未定义；实现后证明边界内可编码、首条超限在加入 `lines` 前被拒绝，native 对实际 >16 MiB 输入返回 batch-level `BUDGET`。独立复审仅发现 C 协议注释漏列该终态，补齐后快速复核 P0=0/P1=0。历史 0.0V 的 Electron helper 路径红灯与 malformed identity P1 继续保留在下节。**
> Graph 历史签字基线：**性能修复前的既有源码曾完整 `npm test`、Electron-enabled `npm run verify`、强制真实 Electron 26/26 exit 0；Graph Filter 15/15、Workbench 14/14、dynamic 5/5、Large 5/5、Watcher 15/15、Network 11/11、Intelligence 17/17，第二轮复审 P0=0/P1=0/P2=2。该数字只保留为历史过程，当前总链只看顶部 0.0W 证据。**
> Graph 动态边界：**300 文件/1279 节点 cold-to-interactive、cache/incremental、筛选/内存/布局、AX/键鼠、三类纠错、stale/Issue→Changes、failure live、重启与项目隔离均进入真实 Electron；正文/History/ledger 的零写入门禁通过。**  
> Graph 保留 P2：**200% 仍采用 CDP DeviceMetrics 等价模拟，未调用 Electron `setZoomFactor(2)`；pan/zoom 以 Long Task observer 为性能证据，空数组也会通过，但 transform 的真实变化已有断言。这两项不阻塞签字，后续不得误记为已关闭。**  
> 产品权威规格：`../docs/WRITCRAFT-PRD-V3.md`  
> Phase A 工程契约：`../docs/PHASE-A-IMPLEMENTATION.md`
> 真实作者验收契约：`../docs/AUTHOR-ACCEPTANCE-V1-CONTRACT.md`（已冻结；0.0U 不改变真实作者门禁）
> Changes/History 恢复契约：`../docs/CHANGES-HISTORY-RECOVERY-V1-CONTRACT.md`（2026-07-26 已冻结并完成全链签收）
> Diagnostic Export 契约：`../docs/DIAGNOSTIC-EXPORT-V1-CONTRACT.md`（2026-07-26 已实现并完成自动化产品链签收）
> Image Review 契约：`../docs/IMAGE-REVIEW-V1-CONTRACT.md`（2026-07-27 Trash 扩展已签字，待真实付费/作者验收）

## 0. 续作口令

Chat/Chapter、Onboarding v2、Research→Changes、Inline Rewrite 与 Plan Strict 的当前主链已经关闭。下一轮恢复时不要重写这些协议，也不要分发现有 `release/` 产物。

1. 读本文、`package.json`、当前源码文件与 `git log -1 --stat`；本地 Git 历史从 2026-07-26 V0 基线开始，不得据此臆测更早的开发过程。
2. **Diagnostic Export v1、Research Accuracy v1、committed-warning、Graph 三项韧性缺口、Changes/History durable recovery、Image Review v1 与 Image Trash 本地链均已完整签收，不再重开这些协议。**
3. 0.0W 已完成技术签字。恢复顺序必须是：先确认本文与当前 Git 提交 → 冻结可信文件系统根 fd 到项目根的逐段身份合同与隐私边界 → 写项目外祖先换壳红测 → 再实现/全量/真实 Electron/package/release/独立复审。不得重开已关闭的 metadata 上限，也不得把初始根链 P2 写成已消除。
4. 不重写已经签字的 Onboarding v2 service、capability store、batch、Main/preload 与 Renderer 契约；Main 动态 admission、single-flight 和 Renderer 生命周期 authority 清理均已关闭。
5. 每批合入后重跑定向测试；阶段完成时再运行完整 `npm test`、`npm run verify` 与 `WRITCRAFT_E2E_FORCE=1 npm run e2e:electron`，保存当次证据。
6. 真实 API 只使用用户显式配置的 Key；记录延迟、限流、超时、故障和费用，不记录 Key、Prompt、模型原文或正文。本轮 ad-hoc 包只用于验证；完成真实作者闭环后仍须重建并做干净账户、Developer ID、公证和 Gatekeeper 复审。

### 0.0W 2026-07-28 native hash 序列化请求预算（独立复审签收）

- **红灯**：深 128 级、长路径、宽 identity 的批量输入在 0.0V 只受 5000 文件/64 MiB 内容预算限制，会先构造超过合理边界的 metadata payload。新增回归先因 `MAX_REQUEST_BYTES` 不存在稳定失败。
- **JS 门禁**：`encodeBatch()` 将完整 header、每条 item 与 LF 按 UTF-8 精确增量计数；固定 16 MiB。任何一条会越界时先返回 `PROJECT_WATCHER_HASH_BUDGET`，再加入 `lines`，不会先拼出超大完整 payload。
- **native 门禁**：helper 用同一 16 MiB 上限累计实际读取的 `line_length + 1`，包含 header 与每条 LF；超限输出唯一批次终态 `E <seq> ERR BUDGET`、关闭根 fd 并失败退出。Main 将该终态映射为同一预算错误并终止 worker。
- **验证与复审**：worker **12/12**（含边界内、首条超限、真实 native >16 MiB 输入与终态映射）、Watcher **30/30**、cross-layer **11/11**、Large **6/6**、package **8/8**、release **7/7**；完整 test/verify、Persistent **3/3**、强制真实 Electron **32/32**。独立复审最终 **P0=0/P1=0/P2=1**；metadata 上限 P2 已关闭。
- **剩余 P2**：初始 `fs.openSync(rootPath)` 仍解析项目外层祖先。0.0V/0.0W 只证明绑定项目根 fd 以下的逐段权威与协议资源边界，不能宣称全路径 TOCTOU 已消除。

### 0.0V 2026-07-28 watcher 祖先逐段 `openat`（历史；metadata P2 已由 0.0W 关闭）

- **已实现**：新增 universal native `project-hash-helper` 与持久 `project-hash-worker`。Main 扫描时私存项目内部每级目录及叶子的完整 BigInt identity；helper 从已绑定的项目根 fd 出发逐段 `openat(O_DIRECTORY|O_NOFOLLOW)`，读前/读后验证叶子，并重新遍历祖先链。普通公开 snapshot 字段保持既有 Number 兼容语义。
- **协议与生命周期加固**：扫描根与 worker 根的 `{dev,ino,mode}` 必须一致；缺失 `O_DIRECTORY/O_NOFOLLOW` 明确返回 unsupported；helper 的 malformed successful identity 被捕获为协议失败，不能从 EventEmitter 回调逃逸并终止 Main。开发态与打包态 helper 路径以 `!process.defaultApp` 明确区分。
- **双-helper发行链**：release schema v4 分别绑定 author-copy 与 project-hash 的 source、signed universal build、App helper 和标准 `unzip` 后 helper；两个 helper 均独立验签并执行，完整 App tree 与当前源码一致。
- **验证与复审**：native worker **10/10**、Watcher **30/30**、cross-layer **11/11**、Large **6/6**、package **8/8**、release **7/7**；完整 `npm test`/沙箱外 `npm run verify` exit 0，Persistent **3/3**、强制真实 Electron **32/32**。独立复审最终 **P0=0/P1=0/P2=2**。
- **精确边界**：本批关闭已绑定项目根 fd 以下的祖先替换，不关闭初始根路径打开时其外层祖先竞态。第二个 P2 是当时尚未约束序列化 metadata/payload 总字节；现已由上方 0.0W 的 16 MiB 双侧门禁关闭。目录枚举/watcher 的非原子性及同 UID 已持有 fd 的并发改写继续作为范围说明；身份漂移、helper/预算失败均 fail-closed。

### 0.0U 2026-07-28 native reserve 预所有权副作用加固（独立复审签收）

- **红灯与根因**：测试专用 helper 在 `mkdirat` 后、`openat` 前把原目录移走并放入 0755 空目录。旧实现会先对打开对象执行 `fchmod(0700)`，再把它当成合法 stage；这证明 helper 在尚未建立本次创建所有权时，既修改了外来目录，也会接受可观测异常替身。
- **修复**：`mkdirat` 在临时 `umask(0077)` 下执行并恢复调用方 umask；打开后只读验证 fd/path 的 `dev/ino`、目录类型、低九位 0700、当前 euid 与空目录，验证前不 `fchmod`、不写 receipt、不清理、不发布。目录扫描无论成功或报错都关闭复制 fd；不依赖 APFS 特有的 `st_nlink == 2`，并允许 setgid 父目录继承 supplementary group。
- **覆盖边界**：测试宏只进入临时测试二进制，正式 helper 不包含攻击标记。新增动态回归证明 0755 替身被拒绝且原目录、替身权限与内容均不改变；另证明 shared/setgid 父目录仍可合法 reserve。Author 从 **47/47** 升至 **48/48**。
- **验证与复审**：两种 Clang `-Wall -Wextra -Werror` 通过；Author **48/48**、Offline API **15/15**，合计 **63/63、0 网络**；完整 `npm test`、沙箱外 `npm run verify`、Persistent **3/3**、强制真实 Electron **32/32**、package **8/8**、release **7/7** 均通过。正式 universal helper、App 与 ZIP 已从当前源码重建；仍仅为 ad-hoc 本地证据，禁止分发。独立复审 **P0=0/P1=0/P2=1**。
- **接受的 P2**：同 UID 攻击者若在极窄窗口放入同属当前 euid、低九位 0700、空且路径/fd 一致的目录，事后检查无法证明它不是本次 `mkdirat` 的对象。macOS 11+ 公共 ABI 没有“创建目录并原子返回 fd”的原语；随机名只降低概率，不构成所有权证明。当前威胁模型明确接受此残余；若未来必须关闭，先改变 staging 权限/父目录架构，不能宣称本批已彻底消除。

### 0.0T 2026-07-28 Plan 写入终态时序（历史；reserve 边界已由 0.0U 更新）

- **历史红灯没有被重跑抹掉**：0.0S 首次真实 Electron 在“接受 Plan 任务后写入正文”阶段超过 15 秒。旧诊断只有最终文案等待，不能区分接受、应用、磁盘提交或界面收口。
- **确定性根因类**：Main/Workspace 的 `reconcileChangesHistoryAfterMutation` 已从磁盘读取并安装 tree、当前文件与 History，再精确清除恢复 marker；Changes Renderer 随后又无条件执行第二轮 `refreshTree/reloadCurrent/loadHistory`，使“磁盘与 History 已提交”的终态文案错误依赖一个非权威、无界的重复 IPC 链。故障注入把该重复 refresh 永久挂起，旧实现稳定无法进入终态。
- **修复**：只有 `authoritativeReloaded === true` 时，普通、残余、Research residual-unavailable 与 Onboarding/edit.md 成功分支跳过重复 tree/current/history；当前文件不是 `edit.md` 时仍显式打开它。`false/undefined`、不可信响应和恢复失败继续走旧 fail-closed 刷新/锁定路径。
- **可观测性**：真实 Electron 先单独点击并断言唯一 hunk 已接受、按钮可用，再单独应用。超时诊断仅记录 accept/apply 阶段、耗时、UI 布尔/计数/文本长度及磁盘 bytes/SHA-256，不记录正文、Diff、绝对路径、Prompt 或凭据。
- **验证与复审**：新增普通、Research residual-unavailable、Onboarding 当前非 `edit.md` 三条重复-refresh 挂起回归；Renderer dynamic **25/25**。完整 `npm test`、沙箱外 `npm run verify`、Persistent **3/3** 通过；本地两次和独立复审一次真实 Electron 均 **32/32**，Plan apply 分别约 **205ms、224ms、1078ms**。独立复审最终 **P0=0/P1=0/P2=0**，本轮 timing P2 关闭。
- **当时剩余边界**：0.0T 当时仍列两个本地安全 P2（纯 Node 祖先逐段 `openat`、native `mkdirat→openat/fstat` 微窗口）及外部门禁；native reserve 项后来由 0.0U 关闭可观察副作用并明确接受 residual，祖先项现已由顶部 0.0V 关闭到“已绑定项目根以下”的范围。不能把任一批写成 V0/发布完成。

### 0.0S 2026-07-28 reserve receipt / build-attestation（历史；第三轮独立复审签收）

- **reserve 真相与恢复**：Main 创建并持有匿名、`0600`、`O_RDWR` 的 receipt fd 5；helper 在任何 `mkdirat` 前以 `fcntl(F_GETFL)`、类型和权限预检它。stage 身份核验与 parent `fsync` 后，helper 写入并 `fsync` exact `{name,dev,ino,mode}` receipt；stdout/status 丢失时 Main 只从该 receipt 恢复，不公开恢复细节。
- **失败与清理**：stdout 与 receipt 都不可用时 fail-closed，保留未知 stage，绝不猜测删除；readonly receipt 在创建 stage 前拒绝。身份已经由打开 fd 证明后，parent `fsync` 或 receipt 写入失败会按 exact `dev/ino` 重新核验后尝试清理；发现换壳则不 adopt、不删除。`mkdirat→openat/fstat` 身份未知微窗口仍保留为 P2。
- **构建/打包因果**：native build signature 已进入 recipe；attestation 将 C source/build helper 绑定到 App helper，再绑定到 ZIP helper 与完整 App tree（含 symlink 与 POSIX mode）。release 还固定核对产品名、当前 `package.json` 版本、ad-hoc 签名声明与未公证事实，不能靠篡改 build-info 冒充正式发布。当前 package **8/8**、release **7/7**；本轮本地 ad-hoc App/ZIP 均按当前源码重建，仍禁止分发。
- **验证**：Author **47/47**（含真实 helper 的无 receipt、readonly receipt、stdout/status 丢失、双证据丢失与换壳场景）+ Offline API **15/15** = **62/62、0 网络**；`npm test` 与沙箱外 Electron-enabled `npm run verify` exit 0；Persistent **3/3**。本轮首次 Plan write timeout 在状态诊断加入后未复现，连续两次完整真实 Electron **32/32**；首个 timeout 的 timing 根因尚未解释，保留 P2，不能由重跑绿灯关闭。
- **独立复审与外部门禁**：第三轮独立复审 **P0=0/P1=0/P2=3，可以技术签字**；三个 P2 是纯 Node 祖先逐段保护、native `mkdirat→openat/fstat` 微窗口和未解释的 Plan-write timing。作者显式选择合格项目、完整 `sk-api-`、真实付费/作者旅程、干净账户启动、Developer ID、公证与 Gatekeeper 仍未完成。

### 0.0R 2026-07-27 strict watcher fd hash（已签收；历史）

- **目标与结果**：关闭 0.0Q 唯一 P2 的精确范围：扫描 `lstat` 后，最终文件组件被普通文件或 symlink 替换时，旧 `createReadStream(path)` 会重新解析路径、读取更大目标并继续按旧 size 记账。默认生产哈希现只通过 fd 读取，不再 path-based stream。
- **权威身份与预算**：扫描使用 BigInt stat 私存 `dev/ino/size/mode/nlink/mtimeNs/ctimeNs`；打开使用 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`。打开后、读完后均 `fstat`，返回前再次 `lstat(path)`；任何身份、大小或纳秒时间漂移都进入 `hashErrors`。读取按已验证 size 以 64 KiB 分块，绝不读取候选预算外字节，成功和失败均在 `finally` 关闭 fd。
- **兼容与失败语义**：BigInt 身份不进入公开 snapshot；公开 `size` 与旧 `Math.trunc(normalStats.mtimeMs)` 保持 Number 语义。ordinary polling 的瞬态失败继续返回本轮无权威 hash、等待后续轮转；strict flush 因覆盖不完整返回 `PROJECT_WATCHER_FLUSH_INCOMPLETE`，不发布成功失效或 barrier。
- **红灯与纠错**：新增红测先证明旧实现缺少安全 helper/identity；完整套件随后暴露一次 `mtimeMs` 精度兼容红灯。根因是把内部纳秒安全升级错误地直接改变了公开毫秒舍入，而非产品 watcher 逻辑失败。最终实现把“私有精确权威”和“公开兼容字段”分离，并以 50 轮时间边界及最终 10 轮新套件复跑证明稳定。
- **验证**：Watcher **28/28**（含真实 strict flush scan→open symlink fault、零成功 payload、成功/失败 fd close）、跨层 **11/11**、Large **6/6**；完整 `npm test`、沙箱外 Electron-enabled `npm run verify` exit 0；真实 DOM sanitizer **13/13**；同一源码真实 Electron 连续两次 **32/32**；Persistent Watcher Main/IPC **3/3**。
- **独立复审**：最终 **P0=0/P1=0/P2=1，允许签字与提交**。保留 P2 是 `O_NOFOLLOW` 只保护最终组件，纯 Node 无法对祖先目录进行 fd-relative `openat` 逐段遍历；不得把本批写成“全路径 TOCTOU 已消除”。若以后提升到恶意并发祖先替换威胁模型，须用 native helper 单独关闭。
- **历史下一步（已由 0.0S 取代）**：当时计划处理 native reserve 空 stage/build 因果；该项现已由上方 0.0S 收口。外部门禁仍是作者显式提供合格真实项目、完整 `sk-api-`、干净账户、Developer ID、公证与 Gatekeeper。

### 0.0Q 2026-07-27 Main-owned Watcher flush（已签收）

- **目标**：删除 Renderer 以 1.5 秒时间稳定推断 watcher 已静默的做法。任何在 own-save 或受控外部写后铸造 AI/Onboarding authority 的路径，都先取得 Main 对当前项目 watcher 的显式 flush 证明。
- **权威顺序**：Main 等待既有 polling → 强制再做一轮项目快照 → 立即发布/清空 debounce pending → 发送只含随机 `flushId`、当前 `projectInstanceId` 与 mutation generation 的 barrier。Preload 必须在 invoke 前监听 exact barrier；Renderer 收到 barrier 后等待 `external-sync-state-service` 的队列 drain，任何刷新失败都持续阻止 AI，直到后续成功同步或项目重开。
- **失败矩阵**：不可信 sender、项目切换、watcher degraded/closed、internal mutation in-flight、扫描/哈希/entry-limit 不完整、barrier 发送失败均 fail-closed；不得返回成功、不得铸造新 authority。并发 flush 在 watcher 内 single-flight，不重复扫描或重复推进 generation。
- **隐私与能力边界**：Renderer 只传当前 project instance ID，不传 root、路径、revision、正文或 flush 结果内容；flush 是只读同步点，可因发现真实外部变化推进既有 Main/Renderer generation，但不得写稿件或吞掉 change。
- **验证要求**：Project Watcher 定向测试覆盖强制快照、debounce drain、single-flight、扫描不完整失败和 close 竞态；Main/preload/Renderer 静态与动态边界覆盖 exact barrier、项目漂移和 listener 清理；真实 Electron Onboarding 不再含时间静默 helper，并至少完成聚焦重复与完整 32 阶段回归。
- **完成结果**：Main handler、IPC、preload listener-before-invoke exact handshake、Renderer barrier 后外部刷新 drain、Chat/Inline 可见失败态和真实 Electron 均已接通；1.5 秒 helper 与旧 `externalQueue` 测试等待已经删除。首次 strict flush 主动发布一次全项目失效，扫描期间 internal-mutation epoch、navigation epoch、项目/watcher 漂移和 Renderer 刷新失败全部 fail-closed。
- **对抗修复**：第一轮独立复审在全量绿灯后发现 3 个 P1：内部写可在扫描期间完整发生并结束、初始 poll 可先吸收外部写、Renderer 会吞掉外部刷新异常。三项均先加红灯再修复。自审另发现普通轮转 hash 预算被误用于“完整”flush，已改为独立 5000 文件/64 MiB 全 Markdown hash，超限失败。
- **真实 Electron 过程证据**：一轮旧测试断言曾把运行时 project instance 与不存在的 fixture 字段比较，产品 barrier 已成功但测试红；修正后聚焦 2/2。最终收口前还保留两次不同阶段的等待超时；加入终态快照并把 Graph 的旧 `externalQueue` 等待替换为 Main barrier 后，当前同一源码连续两次完整 **32/32**。
- **最终签字**：Watcher **23/23**、跨层 **11/11**、Workspace **19/19**、Chat **11/11**、Inline **14/14**、Large **6/6**；完整 `npm test`、Electron-enabled `npm run verify` exit 0，Persistent Watcher **3/3**。独立二审 **P0=0/P1=0/P2=1，可以签字**。该批唯一 P2 是 strict hash 的 `lstat→path createReadStream` 本地并发替换窗口；它已由上方 0.0R 的 no-follow fd、pre/post identity 与有界读取关闭到最终组件范围。

### 0.0P 2026-07-27 原生 helper 与 Onboarding E2E 稳定性收口（历史）

- **原生发布助手**：用仓库内 `native/author-copy-helper.c` 和 universal Mach-O `src/main/native/author-copy-helper` 取代 `/usr/bin/python3 -I` 脚本。服务只执行绝对 bundled helper；helper 继续通过继承 fd 3/4 执行 reserve、inspect 和 `renameatx_np(RENAME_EXCL)` publish，不重新解析父目录路径。
- **干净运行时证据**：helper 为 `arm64 + x86_64`、可执行、ad-hoc linker-signed；Author 在空 `PATH` 下可成功创建精确副本，证明运行时不查找 Python 或外部解释器。构建仍要求开发机具备 Xcode Command Line Tools，但分发后的 App 运行不要求。
- **打包闭环**：`prepackage:mac` 会重建 helper；helper 位于标准 `Contents/Helpers`，先独立 ad-hoc 签名，再签外层 App。App/helper 最低系统版本统一为 macOS 11；build-info 同时绑定 C 源码和 packaged binary SHA-256。ZIP 使用 `ditto --norsrc` 排除 AppleDouble，release 以标准 `unzip` 解压后断言零 `._*`、逐项 strict verify，并对解压 helper 运行真实 fd-relative reserve/publish。package 静态检查 **6/6**、release **7/7**；产物未 Developer ID 签名/公证，继续禁止分发。
- **Onboarding 根因（0.0P 当时的临时修复，已由 0.0Q 取代）**：此前红灯不是业务层漏写，而是测试删除外部冲突文件后只等待第一次 watcher generation 变化，便生成新 capability；轮询 fallback 的迟到事件再次推进 generation，产品按设计把提案判 stale。0.0P 曾用 `externalQueue` 加 1.5 秒稳定窗观察；0.0Q 已删除该推断并改为 Main exact barrier。
- **0.0P 稳定性证据（历史）**：Onboarding 聚焦真实 Electron连续 **6 次 2/2**，E2E fatal 加固后再过 **2 次 2/2**，随后完整真实 Electron **32/32**；timeout 分支保留可读 Renderer 状态快照。Harness 从 spawn 起统一清理，进程 exit 与 CDP failure 均进入全局 fatal latch，每阶段及绿线前复核，并强制固定 2/32 计数。
- **0.0P 当时回归（历史）**：Author **42/42** + API Offline **15/15** = **57/57、0 网络**；`npm test`、Electron-enabled `npm run verify` 均 exit 0；package **6/6**、release **7/7**、最终强制 Electron **32/32**。当前总链只看本文顶部 0.0W 证据。
- **复审纠错**：第一轮增量复审在全部绿灯后仍找出 4 个 P1：helper 未独立签名、App/helper minOS 断层、最后 CDP 命令后 Electron exit 可假绿、CDP 初始化失败可能泄漏 child；第二轮又动态证明纯 CDP close 未进入 fatal latch，并发现 ZIP 的 412 个 `._*` AppleDouble 会让标准 unzip 后签名失效。上述缺口均先复现再修复，说明外层 `--deep`、同工具打包/解包、自增 passed 计数和单一 client abort 都不能替代终态证明。
- **最终独立复审（历史）**：**P0=0/P1=0/P2=3，允许技术签字**。当时 P2 为：Watcher 1.5 秒稳定窗不是 Main 显式 flush barrier；native reserve 的 `mkdirat→openat` 极窄 external-process/失败空 stage 残余；build-info 的 C source/binary hash 是并列证据，直接绕过标准 `npm run package:mac` 时不是强因果证明。Watcher 时间窗已由 0.0Q exact barrier 关闭；reserve/build 分别由 0.0U 明确威胁模型与 0.0S 哈希链收口。它们都不是当前下一本地任务。
- **历史下一步（已执行并被取代）**：0.0P 已在提交 `1944950` 完成文档/Nowledge/Git 收口；当时要求先升级 Watcher 时间静默证据，再进入真实旅程。当前只按本文顶部 0.0W 停点续作；不得把本地 ad-hoc 包当公开发布候选。

### 0.0O 2026-07-27 真实作者验收预检与隔离副本底座

- **产品缺口**：冻结合同要求真实项目具备有效 `edit.md`、至少 5 章、2000 个可见中文字符、来源材料和可逆快照，但此前只有文字要求，没有安全预检或工作副本工具。
- **实现**：新增 `src/main/author-acceptance-preflight-service.js` 与 `scripts/prepare-author-acceptance.js`。默认预检完全只读；公开报告只含固定 schema、合格状态、计数、稳定错误码和 SHA-256 快照，不含绝对路径、文件名列表、Prompt 或正文。
- **隔离副本候选**：CLI 同步事务用 cwd/inode 绑定源与目标目录；资格和复制来自一次权威扫描。随机私有 stage 先完成精确写入、权限校验和 readiness fsync；最终源复核是最后一个预提交动作，随后原生 helper 通过继承的 parent fd 和相对 stage/final 名执行 `renameatx_np(RENAME_EXCL)`。primary report 与 secondary inspect 形成已提交/未提交/未知三态；未知态标记 `committed:true`，不进入清理。清理只移除本次拥有的精确身份，遇到 foreign 或目录替换立即停止。
- **当前环境预检**：真实 API 离线合同 **15/15、0 网络**；稳定 App 配置仅报告 `CODING_PLAN`，因此未触发付费图片。最近项目的公开预检为有效 `edit.md`，但 `chapters/` 0、可见中文字符 0、来源 0，明确不合格；未扫描其他私人目录。
- **验证**：Author Preflight **39/39**；`npm run verify:author-acceptance` 合计 **54/54、0 网络**；最终精确候选完整 `npm test` exit 0；沙箱内 verify 只因 Electron 被终止，沙箱外同命令 exit 0；受控强制真实 Electron **32/32**。
- **Electron 波动如实保留**：日终最终重跑第一次在 Onboarding fresh one-time confirmation 等待处超时（1/32 后红灯），未改源码立即同命令复跑为 **32/32**。这证明当前存在非确定性时序 P2；绿灯不覆盖首个红灯。下次进入发布前须在该等待点补状态诊断，并完成连续稳定复跑或定位 watcher/confirmation ownership 时序。
- **六轮复审与候选修复**：首轮 **P0=0/P1=6/P2=2**；后续复审继续发现目标换壳、绝对路径 helper 误发布、stage 身份采用和双 helper 证据丢失误报未提交。所有 P0/P1 均已动态关闭，最终独立技术复审 **P0=0/P1=0/P2=3，可以代码签字**。P2 为 native `mkdirat→openat/fstat` 极窄外部替换残余、干净 macOS `/usr/bin/python3` 依赖，以及 reserve 回执丢失可能遗留空 0700 随机 stage。
- **后续覆盖**：本节的 Python 依赖与 Onboarding flake 已由 0.0P 根因关闭；其余历史过程保留用于追溯。当前下一步只看本文顶部 0.0W。
- **当日复盘**：正确动作包括离线 API 合同 0 网络、凭据只报类型、只检查 App 最近项目的公开计数、不扫描其他私人目录，以及在 Coding Plan/不合格项目处停下。主要失误是先实现顺序式 happy path，再补安全测试；没有在编码前冻结“源快照—祖先身份—目标所有权—提交真相”矩阵，导致 11/11 和全链绿灯仍漏掉 6 个 P1。今天不提交该 WIP，避免把不可签字状态写进 `main`。

### 0.0N 2026-07-27 应用内 Image Trash 恢复/清空闭环

- **用户体验**：Chat 配图面板新增可见“图片废纸篓”，显示数量、总容量和“长期保留·不会自动删除”；作者可逐项恢复到 `assets/generated/`，也可在明确“无法撤销”确认后永久清空当前核验快照。
- **精确权限**：Renderer 只持有项目实例与 `iti_`/`its_` 不透明能力；Main 独占 root、目录、inode、digest 和文件写删权。列表只返回有界时间/大小元数据，恢复/清空经过可信窗口、当前项目、mutation/navigation 和 mutable-project 门禁。
- **并发与真相**：恢复/清空先把精确路径原子移动到随机私有 transaction quarantine，再核验 inode/大小/digest，避免 `lstat→unlink` 窗口误删外来文件；恢复发布失败会清理由本次创建的 exact inode。同 inode 同尺寸原地改写、pre-link/path replacement、late arrival、部分提交、committed-then-threw、目录 fsync 与跨 TTL 精确重试均有动态回归。
- **保留策略**：V0 不做后台或定时永久删除。清空只删除 opaque snapshot 当时核验的条目；期间新进入的图片保留。恢复和清空均不修改 Markdown、`edit.md` 或 `.writcraft/image-reviews.json`。
- **当前证据**：Trash Service **21/21**、Handler **7/7**、Main/preload Integration **4/4**、Renderer **7/7**；完整图片专项 **107/107**、沙箱外 `npm run verify` exit 0、真实 Electron **32/32**。真实 Electron 可见覆盖删除→列表→恢复→重启→保留新到条目→两次确认式清空，且正文/评审证据不变、Renderer 0 HTTP(S)。
- **独立复审与错误沉淀**：第一轮在 15/15 后发现 path-based unlink、committed TTL 和 restore 原地改写 3 项 P1；第二轮在 19/19 后继续发现 empty 缺 digest 快照与 pre-link replacement 遗留 foreign target 2 项 P1。五项均已关闭并增至 21/21。最终独立只读 sign-off 为 **P0=0/P1=0/P2=1，可以签字**；P2 仅是非协作外部进程预持 open FD 并在最后 digest 后改写同一 inode 的 POSIX 通用极窄残余，不会按旧路径误删替换文件。
- **稳定性复盘**：竞态用例曾固定假设 `first` 一定先处理，但 `createdAt`/birthtime 排序并不保证该顺序，导致次日复跑偶发失败。测试现对“实际首个被处理条目”注入竞态，仍严格断言 foreign 内容保留、未处理 peer 不被删除；service 连续 20 轮 **20/20**，不是放宽产品断言。
- **该批当时的下一步（历史，已被 0.0O–0.0R 重排）**：原计划进入真实 `sk-api-`/作者证据；当前续作顺序只看本文顶部。不得再次扩展 Image Trash，也不得用 fixture 质量替代真实作者判断。
- **当日复盘**：今天完成了从“图片只能移入废纸篓”到“用户可看见、恢复、确认清空且不误删并发替换”的产品闭环，并把五项复审发现的竞态缺口全部关闭。一次次日复跑失败并非产品回归，而是测试错误假设 fixture 创建顺序等于生产排序；修正为注入实际首个处理项后连续 20 次通过。另一次流程错误是把 10 秒工具轮询超时误当成 5–10 分钟复审交付窗口，过早中断 reviewer；后续规则是先给新 reviewer 一个真实证据窗口，再按约定 checkpoint 判断是否接管。这两条已写入 `AGENTS.md`。

### 0.0M 2026-07-26 Image Review v1 自动化闭环（历史已签字基线）

- **用户体验**：生成图片后展示真实解码尺寸与请求比例；作者必须给 1–5 分，可选录入两位小数费用及 CNY/USD，再明确选择“插入当前正文 / 保留素材 / 移入废纸篓”。未结算图片会阻止重复生成和项目切换。
- **写入权**：生成本身不改 Markdown；插入仍通过 Workspace 保存门并把目标 revision 交回 Main 核验。保留不改正文；删除改为移动 token 所属精确 inode 到 `.writcraft/image-trash/`，不是永久删除。
- **Main 权威与隐私**：短期 token 绑定可信窗口、项目、mutation/navigation、operation 与资产身份；Renderer 不持有 root、digest、绝对路径、Key 或图片字节。`.writcraft/image-reviews.json` 只记录 operation、评分、终态、可选费用和时间。
- **可靠性**：生成目录、诊断导出父目录及图片证据临时文件均补 inode/canonical/nlink 复核与精确清理；插入或废纸篓移动已提交但证据写入失败时保留可恢复真相，精确重试不重复插入或移动。
- **作者证据可见**：配图面板显示项目累计样本、平均评分以及插入/保留/废纸篓计数；生成耗时与失败仍由既有八字段隐私指标负责，不把 Prompt、正文或远端错误写入评审证据。
- **该历史批自动化**：Generation **15/15**、Review Service **16/16**、Handler **9/9**、Renderer **8/8**、Metrics Renderer **20/20**、Network **15/15**；当时 `npm test` 与 Electron-enabled `npm run verify` exit 0，强制真实 Electron **31/31**，Persistent Watcher **3/3**。该数字只证明 Image Review 专项，当前项目总链已由顶部 0.0W 的 32/32 覆盖。真实 Electron 已覆盖评分后插入、Main/IPC 保留、重启与零 Renderer 网络。
- **独立复审**：首轮发现 3 项 P1 与 3 项 P2；已关闭生成后签发失败孤儿、committed inserted 恢复受旧 revision 阻断、evidence rename 后 fsync 未补做，以及 handler map、诊断部分文件清理问题。最终 **P0=0、P1=0、P2=1**。
- **当时未完成边界（已被 0.0N 部分覆盖）**：真实 `sk-api-` 图片质量/费用/限流/超时、真实作者判断和发布包均未签字；本批当时唯一 Image Review P2 是缺少应用内废纸篓恢复/清空，现已由 0.0N 实现。Graph 另有顶部列明的两项历史保留 P2，不得混为同一复审范围。App/ZIP 继续禁止分发。
- **今日交付**：建立本地 Git `main` 基线；完成并独立签收 Diagnostic Export v1；把 Image Review 从“生成后插入/放弃”升级为评分、费用、三类终态、可恢复废纸篓和项目聚合，并在复审修复后签收自动化链。
- **今日过程错误**：Image Review 首轮绿灯后过早进入完成表述，独立复审仍找出 3 项 P1；诊断“部分写入”最初只在写入前抛错，没有真实写入字节；rename 后 fsync 重试最初只证明文件可读，没有证明第二次目录 fsync；旧测试一度仍按旧 IPC 契约判断；文档逐项更新后仍残留 0.0L、12/12、30/30 和“待复审”等过期说法。
- **明日效率规则**：先执行无外部依赖的废纸篓 UI 闭环；任何付费或不可逆动作先做容量/authority 预检并取得 owner lease；故障注入必须穿过真实副作用边界；实现绿灯后必须独立复审再签字；日终横向核对源码、测试、README、PRD、Phase A、专项契约、PDCA、状态台账和同一条 Nowledge 权威记忆。

### 0.0L 2026-07-26 Diagnostic Preview / Export v1 自动化产品链签收

- **用户体验**：设置页新增“诊断与隐私 → 预览诊断信息”。作者先看到可能导出的完整 UTF-8 JSON 和排除说明，只有显式点击“导出这份诊断”后才打开原生保存窗口；关闭、刷新或取消均不写文件。
- **隐私边界**：Main 只构造递归 exact-key allowlist，内容限于应用/运行时版本、项目是否打开、文件数量、`edit.md` 结构状态、watcher 状态、私有指标计数和稳定诊断码。正文、来源文字、Prompt、模型回答、quote/base64、Key/指纹、项目/文件名、路径、revision/hash、原始错误和 Renderer console 内容全部禁止进入预览。
- **权威边界**：preload 只暴露 `preview()` 和 `export(token)`；Renderer 不提供 JSON、URL 或输出路径。token 绑定可信窗口、项目实例、mutation generation 和 navigation epoch，五分钟过期；项目/页面漂移在保存窗口前后都阻止写入。
- **磁盘安全**：Main 使用原生保存窗口、`wx` 不覆盖打开、`0600`、fsync。写入失败只清理由本次创建且 inode 仍匹配的目标，已有文件、符号链接或并发替换都不会被删除。
- **本批真实缺陷与关闭**：首次 no-overwrite 测试发现 EEXIST 后清理会误删已有目标，已改为“只有本次成功创建才清理”；进一步加固并发替换 inode 门禁。独立复审又发现同步 write/fsync 跨过 token TTL 时可能“已落盘却报失败”，现由 `consumeCommitted` 保持落盘真相并确保 token 不可重放。
- **测试主链**：新增 `verify:diagnostics` 并接入 `pretest` / `preverify`；当批 Service **12/12**、Handler **10/10**、Renderer **7/7**、Network Boundary **15/15**；本轮父目录竞态回归后 Service 为 **13/13**。完整链证据以本文顶部为准。
- **真实 Electron 证据**：在真实项目和可见设置页打开精确预览，验证 schema/字段/文件计数，且项目名、正文 marker、相对/绝对路径、文件名和 `edit.md` 均不出现；关闭后当前文件与正文保持不变，后续 Plan/Graph/Chat/Research/重启链继续通过。
- **独立复审**：Main/验证复审发现并关闭上述 TTL postcommit P1；Renderer/preload 独立检查为 P0=0/P1=0。最终结论 **P0=0、P1=0、P2=0**。该签字不替代真实 API、真实作者、真实导出人工保存和发布验收。

### 0.0K 2026-07-26 本地 Git V0 基线

- 项目根目录已初始化本地 Git 仓库，默认分支为 `main`；这是后续代码审计、回退和阶段提交的起点，不追溯此前开发历史。
- 根 `.gitignore` 与 `v0/.gitignore` 共同排除 `.env*`、私钥文件、`node_modules/`、`release/`、构建目录、日志、macOS 元数据和本地 Agent 运行状态；`.env.example` 保留为安全配置模板。
- 首次提交只记录当前源码、测试、产品资料和权威文档。未配置 remote、未连接 GitHub，也未上传任何内容；现有 342 MB `release/` 和 322 MB `node_modules/` 不进入历史。
- 后续每项功能必须把实际源码、对应测试和受影响文档放在同一提交中；验证结果仍需注明真实 Electron、真实 API 或 fixture 范围，Git 通过本身不等于产品验收。

### 0.0J 2026-07-26 Changes/History durable recovery 全链签收

- **原始缺口与关闭结果**：普通 apply/undo 在 History 写入和正文回滚同时失败时可能形成混合磁盘状态。现在原能力在 durable marker 后即终结，Renderer 不再把不确定结果当普通可重试失败，而是先锁定项目、查询磁盘与 History 真值，再自动恢复或要求人工二选一。
- **完整范围**：同一协议必须覆盖 `rollback_failed`、`history_failed_rollback_failed`、History 实际提交后 writer 抛错、reject-only/apply/undo response loss，以及 apply 成功后的 residual/onboarding/tree bookkeeping 异常；不能只补一个错误码。
- **冻结合同**：`docs/CHANGES-HISTORY-RECOVERY-V1-CONTRACT.md` 已冻结 applying/terminal marker、权威磁盘+History 真值矩阵、全局 mutation lock、重启 reconciliation，以及“恢复操作前 / 保留操作后并补 History”两项 Main-owned 人工恢复动作。第三种 revision 或外国 History 一律继续锁定。
- **核心实现已签收**：新增 `changes-history-reconciliation-service.js` 与 `changes-history-transaction.js`，重构 History prepare/execute/expected-state CAS；首次 marker 使用不可覆盖的原子发布，人工恢复写前持久化 `recoveryWritePending`，目录 fsync 失败保持锁定，重试成功才释放。accepted review 归入 apply 真值，reject-only 保持 review。
- **核心证据**：Recovery **24/24**、History **14/14**、Review **15/15**、Composite Guard **5/5**、旧 Inline Integration **7/7**；第三轮独立复审 **P0=0、P1=0、P2=0**。覆盖 apply/undo 双失败、writer committed-then-threw、response loss、History CAS、跨进程 marker 竞争、symlink/hard-link/corrupt/oversize、两项恢复、恢复重试和 fsync durability lock。
- **跨层实现**：生产 Main handler、IPC 与窄 preload 已统一进入 Changes/History transaction；Research apply 复用同一 durable authority。Renderer 启动顺序固定为 Changes→Inline→打开可编辑内容，apply/undo 都执行“锁定→查询→权威重载 tree/current/History→精确 clear→解锁”。Inline 与 Changes 使用独立 blocker，项目 A 的迟到结果不能污染项目 B。
- **人工恢复体验**：恢复面板列出受影响相对路径并提供“恢复操作前 / 保留操作后”。reload、clear 或恢复写失败继续锁定；同一选择可重试。`keep_after`、`restore_before`、首次失败后同动作重试均有动态证据。
- **错误契约**：统一返回 `writcraft.changes-history-error/v1`；Graph Issue 未完成全部修改块时保留 `ISSUE_REVIEW_INCOMPLETE`，不消耗原 capability，也不写正文或 History。
- **最终证据**：Handler **10/10**、Renderer 协议 **16/16**、Workspace 恢复 **7/7**、Changes integration **6/6**；完整 `npm test` 与 Electron-enabled `npm run verify` 均 exit 0，真实 DOM sanitizer **13/13**，强制真实 Electron **30/30**。真实 Electron 覆盖 response loss、两项人工恢复、首次失败后同动作重试、History undo、Graph Issue 完整决策及后续 Chat/Research/重启链；最终独立复核 **P0=0、P1=0、P2=0**。

### 0.0I 2026-07-26 Graph 三项韧性缺口完整签收

- **异步所有权**：Graph build、correction persist/build 和同项目连续 refresh 均绑定项目实例与递增请求序号；旧项目或旧请求的延迟 resolve/reject 不能覆盖当前 Graph。真实 Renderer VM 已覆盖 A→B、persist 中切项及同项目后发请求胜出。
- **输入权威**：Graph Index 对每个 Main 权威文件快照使用内置分析器重建 canonical contribution；自洽伪缓存会以 `AUTHORITY_SNAPSHOT_MISMATCH` 仅重析受影响文件，伪造 injected analyzer 语义会以 `ANALYZER_AUTHORITY_MISMATCH` fail closed。quote、revision、locator、block/content hash 与完整 nodes/edges/issues 语义均不能由缓存自行背书。
- **不可变快照**：Renderer 接收 Graph 后先做有界 structured clone + recursive freeze；getter、accessor、hidden/symbol 字段、稀疏/超长数组、异常 prototype 与 cycle 全部 fail closed，getter 读取次数为 0。Correction 可能已提交 ledger 后若返回非法 Graph，会清空旧 Graph/DOM/issues/detail/cache/selection 并保留 live-region 错误。
- **Unicode 与性能**：Evidence quote 在 240 个 UTF-16 单元边界遇到 high surrogate 会回退一单元，`quote/end/id` 全部基于最终合法字符串。300 文件实测 cold **92.2ms**、cache **60.5–66.9ms**、单文件 incremental **80.7ms**，低于 2500/700/800ms 门禁。
- **最终证据**：Consistency **22/22**、Index **15/15**、Filter **17/17**、Workbench **14/14**、Renderer Dynamic **14/14**、Large **5/5**；完整 `npm test` exit 0；Electron-enabled `npm run verify` exit 0（真实 DOM sanitizer **13/13**）；强制真实 Electron **28/28**；独立二审 **P0=0、P1=0、P2=0**。

### 0.0H 2026-07-23 Research committed-warning 动态故障边界最终签收

- **生产事务边界**：新增 `src/main/research-apply-transaction.js`，Main 的 Research apply 分支真实复用该事务；错误决策在 `beginApply` 前拒绝，提交前 stale/conflict/history failure 保持普通失败，`applyDecision.ok` 后的 bookkeeping、residual、tree 与状态迁移异常一律保持 `ok: true` 的已提交真相。
- **权威结果与单次能力**：committed warning 保留精确 `applied` revision、History 与 Research provenance，强制 `review/changeSetId = null`、`residualUnavailable/refreshRequired = true`；旧/新 capability 均不可重放，卡片按原因进入 STALE / FAILED / EXPIRED。
- **极窄竞态关闭**：即使真实 `finishApply` 已安装 residual 并把卡片推进到 REVIEW 后才暴露异常，也会只结算 exact card/lease/residual，回收 child 并进入稳定终态。`clearExcept` 只在项目派生状态失效期间暂留当前 Research child，随后以非 owner-revoking 原因精确删除。
- **真实故障矩阵**：scratch 项目从真实 Research run → handoff → ACK → Pending Store → ChangeSet/History 执行生产事务，动态覆盖 partial baseline、post-commit source stale、TTL、residual put、finish-after-REVIEW、tree、result getter、reject-only、malformed/pre-apply stale、真实 conflict 与 History rollback。
- **最终证据**：Research transaction **11/11**、handoff **15/15**、integration **12/12**、Pending Store **12/12**、History **14/14**；完整 `npm test`、Electron-enabled `npm run verify` 均 exit 0，强制真实 Electron **28/28**。独立二审最终 **P0=0、P1=0、P2=0**。
- **历史相邻风险已关闭**：本段当时保留的普通 Changes History+rollback 双失败缺口，已由 **0.0J** durable reconciliation/manual-recovery 全链关闭，不再是 TODO。

### 0.0G 2026-07-23 Onboarding single-flight 与 Renderer 生命周期最终签收

- **Main single-flight**：同一 `project.instanceId + rootPath` 同时只允许一个项目卡模型调用；第二请求在付费调用前返回 `ONBOARDING_PROPOSAL_IN_PROGRESS`，不共享首请求 Promise、结果或 capability，也不能释放首请求 lease。
- **精确释放**：success、service rejected、throw、project/generation/navigation drift 均由 owner identity-checked `finally` 释放；新页面不能把 navigation epoch 加进 key 来绕过仍在结算的旧 lease。
- **两侧页面竞态均关闭**：请求捕获 Renderer navigation epoch，模型返回后、任何 authority mint 前复核。导航发生在 await 期间时零 authority；authority 已 mint 但 IPC 尚未送达时，`did-start-navigation` / `render-process-gone` / `destroyed` 会 abort 活动 AI、推进 epoch，并按 exact current project 撤销 Onboarding review/confirmation 及其配对 ChangeSet。
- **清理边界**：项目级 invalidation 只匹配 `instanceId + rootPath` 的 Onboarding review map 与配对 ChangeSet；普通和其他项目 ChangeSet 保持不变。动态测试分别覆盖 no-op confirmation 与 changed review 的清理、保留 unrelated ChangeSet 和立即重试。
- **最终证据**：Handler **11/11**、Main/preload **14/14**、Changes integration **5/5**、Network boundary **13/13**；完整 `npm test`、Electron-enabled `npm run verify` 均 exit 0；强制真实 Electron **28/28**。两轮独立复审依次发现 await→mint 与 mint→IPC delivery 两个 P1 窗口，修复后最终 **P0=0、P1=0、P2=0**。

### 0.0F 2026-07-23 Onboarding Main 动态 admission 阶段签收（已被 0.0G 覆盖）

- **生产路径可执行测试**：`writcraft:project:propose-onboarding` 已复用 `project-onboarding-handler.js` 的 handler factory；动态测试直接执行同一生产 factory，覆盖并发返回、已有 authority 的 pre-model 阻断、TTL、项目/generation drift。
- **双向对账修复**：独立复审发现共享 Pending ChangeSet 容量驱逐会留下 review capability 孤儿。admission 现按 exact `changeSetId` 对账；配对 ChangeSet 已不存在时，只撤销对应 `reviewId` 和 map 项，不删除 unrelated ChangeSet。真实 `maxEntries:1` 驱逐回归已固化。
- **原子回滚证据**：batch 故障注入显式锁定 `ROLLBACK_FAILED → COMMIT_FAILED → force rollback` cause chain，同时保持目标、stage 与 replay authority 全部清理。
- **该阶段证据**：Handler **6/6**、Changes integration **5/5**、Main/preload **13/13**、Capability **15/15**、Batch **22/22**、Network boundary **13/13**；当时完整 `npm test`、Electron-enabled `npm run verify` 均 exit 0、强制真实 Electron **28/28**。该阶段遗留的并发付费 P2 已在 **0.0G** 关闭，不能再作为当前 TODO。

### 0.0E 2026-07-23 Chat 动态失效与 Main 权威取消最终签收

- **动态覆盖补齐**：真实 Electron 分别覆盖 Chat 重开、正文 collapsed selection 与当前文件外部权威修改；每个场景使用唯一问题/响应，避免历史消息造成假阳性。
- **竞态根因与修复**：Main 会先推进项目代际并返回 `PROJECT_CHANGED`，Renderer 的 watcher 事件可能稍后才完成。Chat 现在把该精确权威结果统一归类为“请求已取消”，不再短暂显示“调用失败”；项目内与 standalone→打开项目两条路径均适用。
- **所有权边界**：取消仍在 request token/phase 门禁后执行，只能清除该请求的 preflight，不能擦除更新请求或 actual provenance。
- **最终证据**：Chat directed **11/11**；完整 `npm test` exit 0；Electron-enabled `npm run verify` exit 0（DOM sanitizer **13/13**）；强制真实 Electron **28/28**。最终独立复审 **P0=0/P1=0/P2=0**。

### 0.0D 2026-07-23 Chapter no-op/provenance-invalid 最终签收

- **运行态分类器**：Renderer 生产路径统一把 Main 响应分类为 invalid / no_changes / review；拒绝原型继承对象、错误 target/revision、context 顺序/角色、generation schema、no-op capability/review 泄漏，以及 review inner/outer capability、file policy、唯一目标路径不一致。
- **能力回收**：所有带 capability 的 invalid 响应先按 origin project 确认回收；只有 `ok:true` 或 `CHANGESET_NOT_FOUND` 算完成。失败时不再假称“安全取消”，而提示切换项目或重启笔触。`capabilityReleased` 防止 ownership drift 后重复 discard，同时允许未确认回收走 stale 路径重试。
- **独立复审过程**：首轮发现 capability 回收断链和 review/目标未绑定 2 个 P1，以及 plain-object、provenance 完整性、回收确认 3 类 P2；全部复现并修复。最终独立复审 **P0=0/P1=0/P2=0**。
- **该批签收证据（已被 0.0E 当前总链覆盖）**：Chapter Contract **17/17**、Changes Proposal Transaction **23/23**、Changes Review Integration **5/5**、Pending Store **11/11**、Review State **6/6**；当时完整 `npm test` exit 0、Electron-enabled `npm run verify` exit 0（DOM sanitizer **13/13**）、强制真实 Electron **27/27**。

### 0.0C 2026-07-23 Chat preflight 生命周期 P2 关闭

- **实现**：Context Chips 区分当前请求的 `preflight` 与 Main 实际响应 `actual` 所有权；只允许精确 request token 清除当前 preflight，旧请求不能删除新请求或 actual provenance。
- **主动失效**：scope、selection、`editVersion`、Chat 重开后的隐式 scope、正文内主动折叠选区，以及重命名/移动/回收/外部修改/Inline reconciliation 等 workspace 权威状态变化都会在 guard 失效后同步清除 preflight。焦点进入 Chat 不会被误判为正文主动清空选区。
- **真实竞态门禁**：Electron fixture 延迟旧 Chat 700ms；测试等待带 sentinel 的 preflight DOM 真正替换旧 actual，随后改变 scope、发起新请求并等待旧请求迟到。结果为旧 preflight 立即消失、旧回复不落地并标记取消、新 actual 不被旧 token 擦除，actual 经 scope 变化仍保留。
- **该批复审与验证（已被 0.0E 当前总链覆盖）**：独立二审确认原 3 个实现 P2 已关闭，P0=0/P1=0；当时 Chat directed **10/10**、完整 `npm test` exit 0、Electron-enabled `npm run verify` exit 0（DOM sanitizer **13/13**）、强制 Electron **27/27**。
- **后续状态**：本段当时保留的三条动态测试增强已在 **0.0E** 全部关闭，不再作为续作 TODO。

### 0.0A 2026-07-23 额度收口检查点

- **Plan P2 已形成完整小批次**：新增 Main-owned 可注入 handler，并让真实 IPC 注册复用它；动态测试直接执行同一 handler factory，证明 service 返回 rejected result 时 `pendingPlanRecords` 保持为空、mutation generation 保持不变，且不会读取后置 current-project 成功路径。`package.json` 与 release 产物未修改。
- **本批可复现证据**：相关文件 `node --check` 通过；Project Plan **19/19**、Plan handoff **15/15**、Assistant integration **11/11**、Network boundary **13/13**，最终测试文件上的完整 `npm test` exit 0。独立复审结论 P0=0、P1=0、P2=0。
- **未执行的全链门禁**：本批因额度收口未重跑 Electron-enabled `npm run verify` 或强制真实 Electron；此前 **26/26** 只作为抽取前最近签字基线。进入发布验收前必须在当前源码上重新跑全链。
- **Plan handler P2 已全部关闭**：同一生产 factory 已动态覆盖 rejected result、success cache、模型返回后的项目/generation stale、抛出异常→`projectFailure`；Main 注册片段逐项断言全部十项注入，测试命名不再误称为真实 Electron IPC 启动。
- **恢复来源**：本文是唯一权威状态台账；跨会话摘要同步到 Nowledge Mem，不在项目内制作重复副本。
- **当时下一目标（已被后续状态取代；当前见顶部 0.0W）**：真实作者项目定义旅程仍需执行；0.0O 后续六轮复审已于本日完成，Python helper 门禁也已由 0.0P 关闭。当前门禁见本文顶部，不得从本历史段跳过真实作者授权。
- **外部依赖边界**：完整 `image-01` 验收需要用户配置的完整 `sk-api-`；没有该凭据时可继续关闭非阻塞 P2 测试缺口，但不得伪造图片质量、费用或成功证据。
- **额度门禁**：任何后续开发若剩余额度接近本轮水平，先停止扩展实现，同步本文、相关合同和 README，再更新 Nowledge Mem 主记忆；不制作额外项目副本。

### 0.0B 2026-07-23 Graph 性能复验最终签收

- **复验先绿后失败**：Plan handler 抽取后的 Electron-enabled `npm run verify` exit 0，真实 DOM sanitizer 13/13；根 lane 首次强制 Electron 26/26。独立 lane 随后在第 10 阶段发现 `graph-file-filter` 单次 **233.8ms > 100ms**，证明一次绿灯不足以签字。
- **第一层根因与修复**：`graph-filter-state.nodePaths` 曾为每个节点重建整张 evidence Map，文件筛选近似 O(nodes×evidence)；Graph 也会为每个投影重新布局。现按 Graph 快照缓存 evidence/path 派生，筛选复用全图稳定坐标，并只渲染两个端点都可见的 edge。定向套件提升为 Filter 16/16、dynamic 6/6；根 lane 强制 Electron 26/26，但独立 lane 清除筛选仍为 **163.8ms > 100ms**。
- **第二层根因与修复**：慢操作的 value 为空，实际是清除文件筛选恢复全图。secondary file/time/query scene 曾覆盖 baseline 全图 scene，导致清除时同步重建 1279 节点。缓存所有权随后被收紧为 exact graph/scope/currentPath/selectedNode，布局与节点身份不再随 secondary filter 重建。
- **第三层根因与修复**：恢复 baseline 虽未重新创建元素，仍会把全部原始 node/edge 从 projection scene 同步移回，`issues → all` 曾实测 **150.5ms > 100ms**。当前类型筛选改为 scene 级 CSS 可见性，file/time/search 使用同一 baseline 上的 secondary 隐藏标记；任何投影都不再搬移节点、边或丢失键盘/AX 身份。
- **门禁自身缺口与修复**：首次实现仍在缓存判断前无条件 detach/reappend 整棵 SVG scene，且旧 E2E 在 `dispatchEvent` 返回即停止计时，未包含 CSS 可见结果。现只有 cache miss/new scene 才替换 SVG；dynamic 测试真实统计 detach 为零并锁定键盘节点 parent。Electron 对每次 type/file/time-start/time-end/search 更新等待两帧、读取 `getComputedStyle` 与 SVG layout 后才记录耗时，失败信息包含序号、from/to 与完整 durations。
- **最终定向证据**：相关 `node --check` 全过；`npm run verify:graph-renderer` exit 0，Graph Filter **16/16**、Workbench **14/14**、Renderer dynamic **9/9**、Large **5/5**。独立最终复审 P0=0、P1=0、P2=0。
- **该 Graph 性能批签收**：当时源码完整 `npm test` exit 0；沙箱外 Electron-enabled `npm run verify` exit 0（DOM sanitizer 13/13）；随后在无中间源码修改下连续两次强制真实 Electron 均为 **26/26**。两轮均通过新的可见帧 ≤100ms 门禁；Graph 性能复验关闭，不再以旧失败或单次 retry 绿灯继续循环。当前总链见本文顶部。
- **保留 P2｜非阻塞**：WeakMap 路径缓存依赖当前生产约定——Renderer Graph/Node 是整体替换的不可变快照；刷新、纠错、项目切换都满足，但尚未通过 freeze/version 机械强制。后续应冻结契约或增加显式 cache version。
- **Nowledge 同步**：额度恢复后已先更新现有 WritCraft 主记忆；本次最终签收在本文与 Graph 合同落盘后继续更新同一记忆，不制作项目副本。

### 0.0 文档同步门禁（2026-07-22 第十二次收口后固化）

- **唯一当前真相**：当次磁盘源码与可复现命令结果优先；本文记录当前结论、风险和下一步。合同记录对应产品链的冻结边界；README/路线图/PDCA 只作产品概览或历史背景。
- **每批必做**：任何功能完成、缺陷关闭、独立复审或全量验证，在开始下一项开发前，同步更新本文及受影响的合同、README 和路线图；未更新的旧 TODO 不得继续执行。
- **历史数字标注**：20/20、21/21、26/26、28/28 等局部或旧源码数字必须说明日期和覆盖范围，且明确“非当前项目总链”；当前总链只能引用本文顶部的实际执行边界。
- **续作检查**：恢复任务先读本文、相关合同和 `package.json`，再运行最小能验证当前判断的命令；若文档与源码/命令冲突，先修文档或状态结论，禁止以旧文档扩展修复范围。
- **该历史批审计结果（2026-07-27 0.0N 最终复核）**：README、PRD、Phase A、作者验收合同、Image Review 专项合同、`AGENTS.md` 与本文当时已按 Trash 签字同步；产品总链提升为 **32/32**，0.0M 的 31/31 降为历史基线。其后 0.0O 技术候选已完成六轮复审并签字，当前门禁见本文顶部。

### 0.1 Research Accuracy v1 最终签字（2026-07-22）

- **已签字能力**：来源打开后显式“主张匹配/主张不匹配”、不匹配保持 Changes 锁定、同卡改判替换而非新增样本、项目私有聚合，以及窄化的 Main/preload IPC。
- **该批定向证据（历史）**：Research judgment transaction **10/10**、project watcher health **4/4**、Persistent Watcher real Main/IPC **3/3**、Legacy migration **12/12**、Inline integration **7/7**、Graph Issue handoff **6/6**、Network boundary **13/13**；此前同批 Sources UI **16/16**、Sources race **5/5**、Research Renderer **13/13**、Metrics service **18/18**、Watcher **16/16**、Research handoff **15/15**、Metrics integration **8/8**、Research integration **12/12** 当时均绿，相关 `node --check` 全过。当前总链只看本文顶部。
- **P1-1｜已修并通过第四轮复审**：任何 filename-less watcher 事件继续 fail-closed，不按公共 Markdown 指纹猜测内部回声。判断事务先验证无并发 mutation、取得 exact owner/navigation/READY lease 并解析 live authority，之后才推进 generation 与 pause/flush；无效、非 READY、错误 owner 或 stale 请求对 generation 和其他工作保持零副作用。
- **P1-2｜已修并通过第四轮复审**：专用 metrics 写入在原子 rename 前重验完整公共指纹与 canonical card/source/revision/grade/quote；重启 watcher 后再做终检，只重绑 exact card，同 run sibling 保持旧代际。连续重启失败会设置与 exact project instance/root 绑定的 degraded 门禁，后续 `runAiRequest`、`requireMutableProject` 与 Changes apply 均返回 `PROJECT_WATCHER_UNAVAILABLE` 并要求重新打开项目；成功重新挂载 watcher 后才清除。
- **Renderer 诚实状态｜已接通并通过第四轮复审**：只有 `ok && recorded && handoffAvailable === true && evidenceChanged === false` 才解锁交接。若 Main 返回“判断已记录，但证据随后变化/监控不可用”，旧卡片会锁定来源、判断按钮与 Changes，展示 Main 消息，且不得重试旧卡片或进入 Changes。
- **第三轮新增 P1｜已修并通过第四轮复审**：项目进入 watcher-degraded 后，`writcraft:rewrite:apply`、`confirm-legacy-edit` 与 `handoff-graph-issue` 曾可在 Main AI 门禁前进入正文、History 或 Graph 私有状态写入。Inline apply 与 Graph handoff 现使用 `requireMutableProject()`；legacy confirm 在已有同根 current project 时使用 exact project health/mutation gate，但保留“首次迁移尚无 currentProject”的合法流程，迁移后由 `openProjectRoot` 建立 watcher。
- **第三轮恢复缺口｜已修并通过第四轮复审**：`projectService.openProject` 对同一路径生成稳定 instanceId；`setCurrentProject` 现在识别 same-binding degraded/null-watcher 的显式恢复入口并真实 restart。失败保持 degraded，成功才 clear；动态回归调用生产 `openProject` 同路径两次，而非伪造新 instanceId。
- **第三轮扫描扩展｜已修并通过第四轮复审**：Inline reconciliation / reconciliation-clear 可能写 marker 或 History，现均在副作用前执行 exact watcher health gate；全 handler 扫描其余 `requireCurrentProject` 命中只涉及读操作或内存 capability 清理。
- **已冻结的线性化语义**：原子 metrics rename 前的最后一次权威重验是“作者判断成立”的时点。若来源仅在该时点之后变化，当时有效的历史样本可以保留，但 exact card 不得重绑、Changes 必须保持锁定，UI 必须明确提示“判断已记录，但证据随后变化”；不得把 sibling card 一并复活。
- **第四轮复审发现与最终关闭**：第四轮曾保留 P2——真实 Main/IPC persistent-failure 零副作用 harness 尚未固化。现在新增 `verify-v0-watcher-persistent-main-ipc.js`，从真实 BrowserWindow 经正式 preload/IPC 验证 degraded 下 rewrite apply、Graph handoff、Changes reconciliation query/clear 与已有同根 legacy confirm 全部返回 `PROJECT_WATCHER_UNAVAILABLE`；递归 lstat/mode/SHA-256 快照证明公开文件、History、recovery 与私有 metadata 零变化，首次无 current project 的 legacy migration 仍原子成功。
- **安全测试注入**：`WRITCRAFT_E2E_WATCHER_FAILURE=1` 只有 unpackaged + AI fixture + watcher failure 三重 Main-only gate 同时满足才可达；Renderer/preload 无控制面，packaged build 永不可达。标准 32/32 与专项 3/3 使用独立 Electron 进程，环境不互相污染。
- **该 Research/Watcher 批历史最终复核**：Persistent Watcher Main/IPC **3/3**、Network Boundary **13/13**、Watcher Health **4/4**；完整 `npm test`、Electron-enabled `npm run verify`、标准强制 Electron **30/30** 全部重跑通过，独立复核 **P0=0、P1=0、P2=0**。`npm run verify:full` 已串联标准 30 阶段与 watcher 3 阶段；当前总链见本文顶部。
- **更早 Graph 性能批全量门禁｜历史证据**：完整 `npm test` exit 0；沙箱外 Electron-enabled `npm run verify` exit 0（含真实 DOM sanitizer **13/13**）；当时受控强制真实 Electron 从第一阶段顺序运行至结束 **26/26**。首次 Front Matter 超时后，后续三次该阶段均通过；两次中途失败分别是不同 Graph 筛选的单次 **265.2ms/116.4ms > 100ms** 性能抖动，最终同源码全链通过。未发现重复 watcher 或新增 Renderer Graph 负载，不据此重写已签字 Graph；当前总链见本文顶部。
- **迁移诊断回归**：Legacy migration **12/12** 新增动态证明 `editor.md → edit.md` 文件名迁移与 `edit.md` Front Matter v0→v1 reviewed ChangeSet 是两条独立链；Electron 超时现在会附带 Changes status/button/mode 诊断，防止再次只得到无上下文超时。
- **发布状态不变**：Research Accuracy v1 产品链已签字；0.0W 双-helper ad-hoc App/ZIP 已按当前源码重建并验证但禁止分发，真实 API、真实作者、干净账户、Developer ID 签名/公证与发布复审仍未完成。

当前 App/ZIP 与 0.0W 源码一致但仅为 ad-hoc 本地证据，**禁止分发**。历史 `259/259`、`312/312`、`335/335` 只对应旧快照，不可作为当前发布签字。

### 0.2 2026-07-22 第八次收口的历史停点（已被第九次 Graph 签字覆盖）

| 范围 | 作者实现与运行证据 | 独立复审结论 | 下一轮状态 |
|---|---|---|---|
| localized edit / Plan / 普通 Changes | strict localized edits、stopReason 门禁、模型后与应用前 revision 复核；普通 Changes 双文件真实 Electron 通过 | 已完成复审，P0/P1/P2=0 | 保持，不重做 |
| Graph PRD 合规 | 作者纠错、Issue→Changes、三类补充 Issue、筛选语义、项目切换与异步所有权守卫均已落地；14 组 Graph 脚本通过 | P0=0、P1=0；仅保留非阻塞 P2 | 扩展验收已于第九次收口签字；仅保留顶部两项非阻塞 P2，不重开主链 |
| Chat project/file/selection | selection 必选、完整 request token/guard、正文 H1 Source locator、三层 scope 与可点击 Chip；强制 Electron 20/20，reviewer 另跑两轮各 20/20（合计 40/40） | **原 3 项 P1 已关闭；P0=0/P1=0/P2=1** | 保持主链；P2 仅补旧 preflight chips 主动清空 |
| Chapter 生成/整体重写 | strict plan/block、多区块生成、Main 本地组装、完整 session/request/pending 所有权与 origin capability 回收；Electron 应用/撤销通过 | **原 2 项 P1 已关闭；P0=0/P1=0/P2=1** | 保持主链；P2 仅继续固化部分 no-op/provenance-invalid 运行态测试 |
| Onboarding v2 独立底座 | strict metadata-only service、一次性 capability store、authentic-store 原子 batch 均已落盘；收口复跑 **22/22、15/15、22/22** | 动态 admission、TTL/eviction 对账与 rollback cause chain 已签收 | 已签字；下一轮不得重做 |
| Onboarding v2 Main/preload | v2 route、review/no-op token、完整 `edit.md` apply 后铸 token、single-flight、Renderer epoch 与生命周期精确清理均已落盘；生产 Handler **11/11**、定向集成 **14/14** | **P0=0、P1=0、P2=0** | 已签字；保持契约，不重写 |
| Onboarding v2 Renderer | exact v2 request、独立 confirmation mode、committed-warning 真相、双授权 all-settled、dynamic 主链接入和 destroy/deferred/rAF 守卫均已落盘；state **8/8**、UI **11/11**、dynamic **12/12** | 第二轮独立复审 **P0=0、P1=0、P2=0** | 自动化与当前源码 App 人工体验均已签字 |
| Onboarding v2 fixture/API/Electron | strict malformed→人工重试→第一次只改 edit→第二次原子建文件；冲突零部分写入、终态 token、迁移/no-op 均有动态覆盖 | 三文件独立复审 **P0=0、P1=0、P2=0**；强制真实 Electron **20/20** | 自动化签字；真实 API 本轮未重跑 |
| Research→Changes v1 | Main-owned canonical card/run、identifier-only handoff、只读 provenance、ACK/TTL/apply lease/residual 与 committed-warning 生产事务均已落盘；Research 12/12、handoff 15/15、transaction 11/11、integration 12/12、Renderer 13/13 | 最终独立二审 **P0=0/P1=0/P2=0**；当前签字总链为 0.0W Electron 32/32 | 产品链与 committed-warning 动态故障边界均已签字 |
| Inline Rewrite / Plan strict | Inline 当前源码 App 已完成预览零写入、拒绝、重载、接受、History 与 undo；Plan 已补 exact envelope、strict JSON、stopReason、资源/错误脱敏门禁，service **19/19**、handoff **11/11** | Inline 与 Plan 独立复审均 **P0=0/P1=0**；强制 Electron **21/21** 含 Plan strict 拒绝→同目标重试 | 两条产品链签字；仅保留 Plan 内部缓存动态白盒 P2 |

Onboarding v2 独立底座的权威文件为：

- `src/main/project-onboarding-v2-service.js`
- `src/main/project-onboarding-handler.js`
- `src/main/onboarding-capability-store.js`
- `src/main/onboarding-batch-service.js`
- `tests/verify-v0-project-onboarding-v2.js`
- `tests/verify-v0-project-onboarding-handler.js`
- `tests/verify-v0-onboarding-capability.js`
- `tests/verify-v0-onboarding-batch.js`

跨层接线还修改了 `main.js`、`preload.js`、三个 Renderer 文件，以及 integration/UI/state/dynamic、fixture/API/Electron 测试。第八次收口当时的源码完整 `npm test` exit 0；沙箱外完整 `npm run verify` exit 0（含真实 DOM sanitizer 13/13）；强制真实 Electron E2E **21/21**。当前最终证据见本文顶部的 **32/32**；普通 GUI 沙箱无法启动 Electron 属于环境限制，不是断言失败。

### 0.3 阶段复盘与恢复原则

- **已经独立签字的主链**：localized edit、Plan→Changes、普通 Changes、Graph 核心，以及 Chat/Chapter 的本轮 P1 修复均已完成独立复审；Chat 的 preflight 生命周期产品缺口也已关闭，不应在下一轮被重写。
- **Chat/Chapter 保留项已清零**：Chat 三条动态失效入口及 Main 权威取消竞态、Chapter no-op/provenance-invalid 均已关闭；两条链最终独立复审 P0/P1/P2=0。
- **Onboarding v2 自动化产品链已经签字**：service、capability、batch 为 22/22、15/15、22/22；Main/preload 当前为 14/14；Renderer state/UI 为 8/8、11/11，dynamic 已随 0.0T 扩展为 25/25；当前 0.0W 完整 verify 和强制 Electron 32/32 均通过。
- **Onboarding v2 当前源码 App 人工体验已经签字**：隔离六章项目中，故意 malformed JSON 后十项回答保持且出现显式“重新整理 edit.md”；重试后提交前 `edit.md` SHA-256 保持 `28a5c89…`，首次接受后变为 `5f8872a…` 并在磁盘第 13 行出现 `E2E 项目卡已确认写入`；两个初始文件始终未创建；提交前后合法 `edit.md` 顶部均未显示“需修复”。本次使用本地确定性 AI fixture，不等于真实 API/作者验收。
- **Main/preload 的诚实提交语义已经固定**：post-commit bookkeeping 或 tree refresh 失败仍返回 `ok: true`、权威 `files` 与 `refreshRequired`；Renderer 会明确提示已创建、需重开且不要重复确认。
- **独立复审已经关闭 Renderer、fixture 与 Main 动态测试链**：Renderer 第二轮及 fixture/API/Electron 三文件复审均为 P0=0、P1=0、P2=0；Main Handler single-flight 与 navigation lifecycle 最终复审 P0=0、P1=0、P2=0。
- **Research→Changes v1 产品链与异常边界均已签字**：`../docs/RESEARCH-CHANGES-V1-CONTRACT.md` 已落地；committed-warning 生产事务动态覆盖真实磁盘/History、residual、TTL、stale、回滚与 undo，最终独立二审 P0=0/P1=0/P2=0。强制 Electron 已覆盖 reject-only、late-open A→B 及 Research→Changes→History/undo。
- **Inline Rewrite 产品链已经签字**：当前源码隔离 App 已完成预览零写入、拒绝、重载、接受后磁盘/History 同步与 Safe Undo；本次本地确定性 provider 不等于真实 API/作者验收。
- **Plan Strict v1 已签字**：`../docs/PLAN-STRICT-V1-CONTRACT.md` 已实现；模型必须 `end_turn`、单一文本块与无外围 strict JSON，重复/危险键、资源超限和路径错误均 fail closed；独立复审 P0=0/P1=0。
- **该历史批当时的下一阶段入口（已完成并被取代）**：先完成 Image Review v1 独立复审，再补真实 `sk-api-`/作者证据、干净打包与发布复审；当前入口只看本文顶部。
- **证据纪律**：本地 Git 历史从 2026-07-26 V0 基线开始；恢复时必须同时核对本文、`git log` / `git diff`、磁盘当前文件和当次可复现测试结果。任何新的通过数字都要写明命令、覆盖范围和是否使用真实 Electron/真实 API。
- **顺序理由**：三级 AI 协作与 Graph 主链均已签字；真实 API/作者价值和发布门禁现在是最早仍开放的产品验收。

### 0.4 Renderer 交叉复审四项缺口（已关闭）

1. **已关闭｜committed warning**：磁盘已提交时保持“文件已创建”真相，展示权威路径、Main 刷新异常、需重开和不要重复确认；不进入普通成功或零部分创建路径。
2. **已关闭｜双授权回收**：review capability 与 confirmation token 分别启动并以 `Promise.allSettled` 收口，任一同步或异步失败不阻断另一项释放。
3. **已关闭｜dynamic 主链接入**：脚本计数固定为 `test=1`、`verify=1`、`preverify=0`、专用命令 `=1`。
4. **已关闭｜destroy/deferred/rAF**：销毁后迟到结果不调用 `onComplete`、不重渲染，排队 rAF 不夺焦点；动态对抗测试已覆盖。

## 1. 今日结束时的工程事实

### 1.1 已接入主流程

- **Phase A 本地项目地基**：普通 Markdown 文件夹、`edit.md`、原子保存、revision、Watcher、Front Matter 诊断、显式冲突处置和项目内 recovery。
- **项目 / 文件 / 段落三级工作区**：文件树、多标签、preview/pin/dirty、selection/scroll 恢复、Inline Diff、ChangeSet、撤销及安全文件生命周期。
- **项目建立向导与 `edit.md` 共创**：Onboarding v2 自动化产品链与当前源码 App 三项体验均已签字。当前源码使用 strict metadata-only、第一次只改 `edit.md`、第二次确认才原子建文件；0.0W ad-hoc App/ZIP 已重建但仍禁止分发。
- **权威 Context 与右侧协作栈**：Main 有界解析引用，`edit.md` 真实进入模型上下文；Chat / Plan / Context / Changes 已接入。Chat 的 selection 必选、同项目并发 request token、Inspector/Chip 所有权与正文 H1 Source locator 已完成修复并独立签字。
- **完整 Chapter 生成/整体重写**：Main 先生成严格区块计划，再逐块生成并本地组装一个整文件 ChangeSet；支持空白章节、`end_turn`、只读依赖复核和历史撤销。Renderer 现绑定 project/target/instruction/context/pending，所有异步边界复验所有权并按 origin 回收迟到 capability；原 2 项 P1 已关闭。
- **Plan→Changes v2**：Plan 保存 Main 权威目标 revision；Renderer 只交接 `planId/taskId`。提案使用独立 `pc_*` capability，依赖漂移、同内容提案碰撞、A/B 任务竞态与脱离 Plan 均 fail closed；真实 Electron 已证明锁定目标经人工接受后才落盘。
- **逐块 Changes 审阅**：Main 生成稳定 hunk ID 与结构化 Diff；默认全部 pending，支持逐块/整文件接受、拒绝、重置、部分提交、残留提案、拒绝审计和顺序撤销。`edit.md` 始终强制整文件决策；提交期间锁定全部审阅控件。
- **一致性 Graph v2 与来源地基**：Node / Edge / Evidence / Issue v2、稳定锚点、人物/变量/时间建模、作者纠错、结构化 Issue→Changes、补充 Issue 类型、筛选/搜索、stale Evidence 和异步项目所有权均已接入；历史真实 Electron 已覆盖 cold UI、AX/键鼠、failure-live、最小窗口、300 文件/1279 节点性能、重启与 A→B。后续韧性批已补完整语义权威、不可变快照和动态 supersede，独立复审 P0/P1/P2=0；当前源码 Electron 复跑边界见本文顶部。
- **Research 闭环与 Changes 交接**：Renderer 只向 Main 传问题/source IDs，handoff 只传 `cardId`/targets；Main 重建 Claim / Source / Boundary、来源 revision/quote/locator、`edit.md` 与 target dependencies。专用 Changes 模式预览零写入，人工决定后才应用，History/undo 保留有界 provenance。
- **`image-01` 插图闭环**：Main 校验 PNG/JPEG、解码尺寸/比例并安全落盘；Renderer 必须收集评分与明确终态。插入写 Markdown、保留零正文修改、废纸篓只移动 token 所属资产，项目切换前必须结算。
- **Author Evidence Metrics v1**：既有八字段指标继续记录 image 生成耗时/失败与接受/丢弃；独立 Image Review 证据只记录评分、三类终态和可选费用。配图面板显示项目累计平均分及插入/保留/废纸篓计数，两套文件都禁止正文、Prompt、模型回答、Key、路径与远端错误。
- **Onboarding 指标/Watcher 握手修复**：成功生成指标只在内存保留固定八字段，等 edit.md 审阅或初始文件确认进入终态后再按顺序落盘；结构失败与人工重试仍即时记录。这样不削弱 filename-less 外部变化的 fail-closed 策略，也不会让 `.writcraft/metrics.json` 的内部原子写误伤活跃 confirmation token。
- **Electron 外部变化与 Graph 性能修复（历史过程）**：该批曾以 `aiContextGeneration` 与 `externalQueue` 收敛作为临时等待；0.0Q 已统一替换为 Main exact barrier。Graph 对同值筛选短路，并复用已渲染的完整 SVG 场景，返回 300 文件全图仍守住 100ms 交互门槛。
- **Metrics origin 项目竞态修复**：inline / Changes / Plan 在操作创建时捕获 `originProjectInstanceId`；Renderer 先要求 current instance 等于 origin，Main 再做 instance gate。A 项目发起、切换到 B 后延迟返回的成功/失败事件都不会落入 B。
- **Main 网络最小边界**：文本只允许 `api.minimaxi.com/anthropic/v1/{models,messages}`，图片只允许 `api.minimax.io/v1/image_generation`。Renderer 由 CSP `connect-src 'none'` 与 session 的 HTTP(S)/WS(S) 拦截双重断网，所有浏览器权限与设备权限默认拒绝。
- **AI 生命周期地基与当前边界**：Main 的生成 IPC 已绑定可信 sender、origin project instance 与 mutation generation；Chat/Chapter、Onboarding v2、Research→Changes、Inline Rewrite 与 Plan 生成均已达到 fail-closed 契约并通过独立实现复审。
- **Watcher 内外源隔离**：Main 成功提交会登记 Markdown revision 与父目录状态；相同 revision 的 fs.watch/poll 回声直接消费，不再二次推进 AI generation 或刷新 UI。引用双阶段导入使用按 root 隔离的 mutation lease；native watcher 同步/异步资源错误都会降级到有界 polling。
- **真实 DOM sanitizer**：恢复 HTML 与 AI Markdown 共用严格 allowlist；删除 metadata/form/media，解包 SVG/MathML/custom namespace，限制 URL、图片类型、尺寸和节点总量。受控执行环境的 GUI 沙箱内启动曾因 `SIGABRT` 失败，这是 GUI 沙箱限制；同一专项在沙箱外真实 Electron 中 **13/13** 通过。
- **稳定应用数据目录**：正式数据固定在 macOS `Application Support/WritCraft`；只迁移验证通过的 Key 配置和最近项目记录，no-clobber、原子写入并收紧目录/文件权限。开发 E2E 使用显式隔离 profile，不再与真实用户配置握手。
- **可解释 API 握手**：打开设置不自动联网；保存 Key 后检测一次，也可由用户显式点击“检测连接”。Main 只向 Renderer 返回 Key 类型、稳定状态、模型可用性与延迟，不返回 Key、远端 body 或未知异常。

### 1.2 已验证的长文与 Electron 路径

- 离线 long-form service E2E 覆盖真实目录、`edit.md`、6 章、来源、原子保存、章节提案、三文件 ChangeSet/撤销、图谱增量分析和工作区恢复。
- 当前 0.0W 签字基线在 `WRITCRAFT_E2E_FORCE=1` 下完成真实 Electron BrowserWindow E2E **32/32**：图片阶段覆盖评分后显式插入、删除、可见废纸篓恢复、重启后精确快照清空与新到条目保留；正文和评审证据保持不变。
- 当前 0.0W 的 `npm test` 与 Electron-enabled `npm run verify` 均 **exit 0**；强制 Electron **32/32**、Persistent Watcher **3/3**。Image Review 原链与 Image Trash 扩展本身继续保持签字。
- 真实 MiniMax 验收脚本只使用合成项目数据并默认断网；显式门禁后，`/models`、最小 `/messages`、项目卡提案和 Research 均成功，正文磁盘保持零修改。当前 Coding Plan Key 可用于文本，但不能作为 image-01 的完整图片 API 凭据。

### 1.3 必须保留的产品语义

- Research 的 **A–D 是用户对来源类型/证据强度的元数据声明**，不是 WritCraft 对内容真伪、方法质量或权威性的背书。
- revision / exact quote 重验证明“此刻仍指向用户选定的原文”，不证明原文事实为真。用户必须阅读 Claim / Source / Boundary 并人工确认后才能进入 Changes。
- `image-01` 生成成功只意味命中格式、安全落盘且可预览；不得在用户明确点击前插入正文。
- 自动化中的 Research / image 调用使用 stub，不等于真实 MiniMax API 质量、账单、延迟、限流或故障行为已验收。
- “文本握手成功”“模型返回可解析项目卡 JSON”“图片 API 可用”是三个独立结论，不得用其中一个替代另外两个。Coding Plan Key 只作为文本凭据；image-01 成功质量/费用验收需要完整 `sk-api-`。

### 1.4 2026-07-19 旧 v1 手动验收缺陷（2026-07-21 已缓解）

以下问题均已在旧 Onboarding v1 链路中修复并进入真实 Electron 回归；它们只是当时的 UX/容错缓解，**不能作为后来 Onboarding v2 安全契约的实现证据**：

- **项目卡结构化输出**：严格候选提取、字符串感知 trailing-comma 修复、512 KiB 输出上限、64 KiB 修复输入上限、最多一次模型修复；最终失败保留全部答案并显示“重新整理 edit.md”。
- **最近项目隔离**：普通自动恢复拒绝 `os.tmpdir()` 下项目；仅未打包且 Main 启用 E2E fixture 时显式允许临时根。用户主动“打开项目”不受影响。
- **Changes 提交语义**：固定显示“当前仅为预览，尚未写入项目”，主 CTA 为“提交 edit.md 审阅决定”；用户接受后才写盘，成功后从磁盘强制重读并聚焦 `edit.md`，避免同文件快速打开留下旧 revision。
- **Front Matter 权威校验**：生成提案进入 ChangeSet 前强制 `schema: writcraft.edit/v1` 且无 error；旧 v0 迁移保留未知字段与正文，只生成审阅 Diff。
- **诊断与迁移入口**：顶部展开稳定错误码、真实行号和原因；可安全迁移时提供“生成修复提案”，纯 warning 不再生成空 Diff，结构歧义要求先按行手动修复。
- **两阶段部分提交**：`edit.md` 已写入而初始文件部分失败时，UI 明确显示已提交状态，Main 仅保留剩余建议，用户可只重试剩余文件或结束，不会重复应用失效 ChangeSet。

本轮诊断同时确认：右侧看到的内容仍是内存中的待审阅 ChangeSet，磁盘 `edit.md` 没有被静默覆盖。修复不得破坏“AI 只生成提案、用户明确确认后才写入”的产品安全语义。

Onboarding v2 已取代上述“容错解析完整 `editContent` + 部分创建续跑”协议：当前协议是 strict、metadata-only、Main 确定性合并，并保证批量创建 all-or-nothing。旧 v1 的已通过回归只保留为迁移/兼容证据。

## 2. 验证快照

2026-07-22 Chat/Chapter P1 关闭后、Onboarding v2 跨层修改前的历史基线证据：

- 作者实现侧当时运行 `WRITCRAFT_E2E_FORCE=1 npm run e2e:electron`：**20/20 stages passed**；覆盖普通 Changes 双文件、Chat 文件/项目/选区三层作用域、可点击 Context Chips、分阶段 Chapter 的整文件审阅/应用/撤销，并保留项目卡、Research、metrics、Watcher、image、restart 与 0 renderer HTTP(S) 链。
- 当时完整 `npm test` **exit 0**、`npm run verify` **exit 0**，强制真实 Electron E2E **20/20**。Day 4 已移除过期文案字符串假设；这些数字不覆盖本次新增的 Onboarding v2 在制代码。
- Chat：原 selection 可排除、同项目文件切换/并发竞态、Front Matter 标题 locator 三项 P1 均已关闭；独立 reviewer 在修复后另跑两轮，各 **20/20**、合计 **40/40**，最终 **P0=0/P1=0/P2=1**。唯一保留 P2 是 scope/selection/editVersion 变化时旧 preflight chips 不主动清空。
- Chapter：该历史批次关闭了在途请求失效与 pending/no-op capability 所有权两项 P1；当时 Proposal Transaction **19/19**、最终 **P0=0/P1=0/P2=1**，遗留 no-op/provenance-invalid 测试固化。该历史 P2 已在 2026-07-23 的 **0.0D** 中关闭，当前为 Proposal Transaction **23/23**、最终复审 P0/P1/P2=0。
- API Key 握手专项：**9/9**；Key 配置 **10/10**；稳定 userData **8/8**；真实 GUI 显式检测连接成功显示 MiniMax-M3 和 8 个可用模型，设置面板打开本身不发请求。
- 真实 MiniMax 合成验收：`models` 约 1.4s；最小文本约 10.2s；项目卡约 19.4s，输出 1 个 edit.md ChangeSet 与 3 个初始文件建议且磁盘零修改；Research 约 2.7s，返回 1 张可验证证据卡并安全修复唯一 quote 坐标。数据为合成内容，不是作者样本。
- image-01 真实诊断：当前 Coding Plan Key 在图片端不可用；应用现已在联网前返回 `IMAGE_KEY_UNSUPPORTED`，不会再把它误报成通用 JSON/握手失败。成功图片质量、费用与限流验收仍待完整 `sk-api-`。
- Changes 独立复审：首轮发现 post-commit 树刷新假失败和提交期间控件竞态两项 P1，及 residual Plan provenance 一项 P2；均已修复。最终定向 **40/40**，P0/P1/P2 为 0。
- 该历史停点的 Graph v2 独立复审：14 组脚本全绿，包括 Consistency **21/21**、Graph Index **11/11**、Corrections **15/15**、Filter **12/12**、Workbench **11/11**、Issue State **10/10**、Graph Handoff **8/8**、Integration **6/6**、Long-form **8/8**、Large Project **5/5**；额外遍历 840 组筛选组合，P0=0、P1=0。当前最终签字证据见本文顶部。
- API 握手独立复审：发现并关闭 model ID 嵌入式 Key、真实验收报告 provider model、损坏配置恢复入口三项 P1，以及图片 408/1039 错误分类两项 P2；攻击性复现与修复后复审均无残留 P0/P1/P2。
- Main 网络专项：MiniMax text **14/14**、network boundary **11/11**、image generation security **13/13**；全部使用 stub fetch，0 真实网络。
- Renderer DOM 安全专项：受控执行环境的 GUI 沙箱内运行因 `SIGABRT` 无法启动 Electron，确认属于 GUI 沙箱限制而非 sanitizer 断言失败；同一命令在沙箱外真实 Electron 中 **13/13** 通过，覆盖危险元素/事件、DOM clobbering、SVG/MathML namespace、危险 URL、远程/SVG 图片、二次解析与超量节点 fail-closed。
- Watcher 专项：**14/14**，包含 native 异步/同步资源错误消费并降级 polling；真实 Electron 另覆盖完整 1200ms polling 周期与 1700ms 在途 AI 的自身保存回声竞争时序。
- Metrics 专项：service **11/11**、Main/preload integration **6/6**、renderer **12/12**；包含 A→B 后延迟成功/失败不落入 B 的动态测试。
- Research 专项：service **12/12**、integration **8/8**、Sources project-race **2/2**，并且 use-time revision/quote 重验只允许交给可审查 Changes。
- image-01 专项：generation security **13/13**、renderer **8/8**；自动化为 stub fetch，0 真实网络。
- `preverify` 已把 Research、image-01、metrics 与协作栈纳入验证链；Onboarding v2 跨层修改之前的完整 `npm run verify` 已 exit 0。

第四次收口新增证据：Onboarding v2 service **22/22**、capability **15/15**、batch **22/22**；Main/preload **13/13**；Renderer state **8/8**、UI **11/11**、dynamic **12/12**。Renderer 第二轮及 fixture/API/Electron 三文件独立复审均为 P0=0/P1=0/P2=0；**该历史时点** Main 还保留两个 P2 测试增强项，现已由 0.0F 关闭。完整 `npm test`、沙箱外 `npm run verify` 均 exit 0，强制真实 Electron **20/20**。

第五次收口新增当前源码 App 人工证据：malformed JSON 保留回答并显式重试；第一次接受前磁盘零写入，接受后 `edit.md` 真正变更且重新读取；初始文件保持零创建；合法 `edit.md` 没有“需修复”。

第六次收口新增 Research→Changes v1 当时源码证据：Research service **12/12**、handoff service/store **13/13**、Main/preload integration **12/12**、Renderer **13/13**；History **14/14**、ChangeSet review **15/15**、Pending store **11/11**。独立实现复审 **P0=0/P1=0/P2=1**；`npm test` 与沙箱外 `npm run verify` 均 exit 0，强制真实 Electron **20/20** 动态覆盖 stale/rerun、late-open A→B、accept、reject-only、History provenance 与 undo，Renderer 0 HTTP(S)。该批源码 App 隔离六章人工旅程中，预览前 target SHA 为 `0153e224…`、`edit.md` 为 `28a5c89…`；应用后只改 target 为 `e008694d…`，来源/`edit.md` 不变；History 为 v3 `research_card`，undo 后 target 恢复 `0153e224…`。

第八次收口新增当时源码证据：Inline 隔离 App 人工完成预览零写入→拒绝→重载→接受→History→Safe Undo；Plan Strict v1 service **19/19**、handoff **11/11**，独立复审 **P0=0/P1=0**。复审期间关闭模型路径回显、原型链信封继承、最多 480 个目标导致约 2.4 GiB 快照压力，以及超大最终 provider request 四项缺口。该批 `npm test`、Electron-enabled `npm run verify` 均 exit 0，强制真实 Electron **21/21**。

第十次收口新增当时源码证据：真实 API acceptance 离线合同 **15/15**、0 网络；Metrics service/integration/Renderer 当时为 **13/13、6/6、17/17**，Onboarding dynamic **13/13**。首轮强制 Electron 在外部冲突文件删除后立即重铸 confirmation，延迟 watcher 事件推进 generation，稳定触发 `STALE_CONFIRMATION`；该历史批曾等待 `aiContextGeneration` 与 `externalQueue` 收敛，现已由 0.0Q Main exact barrier 取代。Graph 当时以完整 SVG 场景复用关闭 300 文件筛选返回全图超过 100ms 的性能失败。当时最新源码 `npm test`、Electron-enabled `npm run verify` 均 exit 0，强制真实 Electron **26/26**；这些历史绿灯已被第十一次收口的 Metrics 复审 P1 推翻为“不可签字”，不得继续当作 Metrics 最终证据。

第十一次收口暂停快照（历史，已被本节最终签字覆盖）：Metrics exact-operation 与正常切项前结算已经验证有效，但当时独立复审为 **P0=0/P1=1/P2=1，不可签字**。待关闭的同源缺口是：pending Onboarding review 的文件生命周期失效与手动丢弃没有可靠 terminal settlement；capability 已消费但指标失败时再次切项可能重复消费并卡死；`edit.md` 已提交后若刷新/进入 confirmation 抛错，accepted 指标可能遗留。必须补四条动态异常测试、复跑全量 Node/verify/强制 Electron，并经独立复审 P0/P1=0 后才能覆盖本段。

第十一次收口第二轮复审（历史，已被下一段最终签字覆盖）：上述四条指标结算缺口及动态测试已关闭，Onboarding dynamic 暂增至 **19/19**；当时复审仍为 **P0=0/P1=2/P2=1，不可签字**。剩余问题下沉为 capability 生命周期：并发双击丢弃/切项必须共享同一个 in-flight release，禁止重复消费非幂等 review capability；Main 已铸造 confirmation 后若刷新或进入 confirmation 失败，必须显式释放 exact token，同时保留 accepted 指标。新增两条并发/异常对抗测试并完成第三轮复审前，先前全量绿灯仍不计作最终 Metrics 证据。

第十一次收口最终签字：同一 Onboarding review 现在用共享 `releasePromise` 合并并发丢弃与项目切换，成功后禁止二次消费、失败后允许安全重试；提交后刷新/confirmation transition 异常会用原项目和 exact token 显式清理，清理失败则阻断新向导与切项直至重试成功，同时原 operation 仍诚实记录 `accepted`。Onboarding dynamic **22/22**、Metrics Renderer **18/18**、Workspace **19/19**、UI **11/11**；最终源码 `npm test`、Electron-enabled `npm run verify` 均 exit 0，强制真实 Electron **26/26**，第三轮独立复审 **P0=0/P1=0/P2=0，可签字**。非阻断后续增强：可增加“首次 review capability release 失败、第二次成功”的独立动态用例，但不重开本轮主链。

准确结论是“Chat/Chapter 主链已经签字；Onboarding v2 自动化产品链与当前源码 App 三项体验均已签字”。不准确的结论是“fixture 人工签字等于真实 API/作者价值或发布签字”、“完整 PRD 已实现”、“当前 ad-hoc App/ZIP 已满足正式发布门禁”或“已可发布”。0.0W App/ZIP 与当前源码一致，但仅是本地证据。

## 3. 当前产品能力矩阵

状态：✅ 已接入且有自动化/行为证据；🟡 已实现但待人工 GUI、真实 API 或安全复审；⬜ 未完成。

| 模块 | 状态 | 当前事实 |
|---|---:|---|
| Electron 安全壳、本地项目、保存/Watcher/recovery | ✅ | 安全边界、路径、revision 与恢复有自动化证据 |
| 三级工作区与右侧协作栈 | ✅ | Chat 三层 scope、selection 必选、并发所有权、可点击 Chip、动态失效与 Main 权威取消均已接入；0.0W 签字基线真实 Electron 32/32 |
| 项目卡 → edit.md → Changes 提交闭环 | ✅ | Onboarding v2 自动化链与既有 App 三项人工体验均已签字；其中 **20/20** 是该链历史专项 Electron 证据，0.0W 当前签字总链为 **32/32**；真实 API/作者价值仍属于发布前验收 |
| Chapter 生成/整体重写 | ✅ | strict plan/block、整文件审阅、撤销、完整异步所有权、no-op/provenance/result/capability 运行态门禁均已接入；最终复审 P0/P1/P2=0 |
| Changes 分块审阅与 Plan→Changes | ✅ | 默认 pending、逐块/整文件决策、residual、审计/撤销和目标 revision 锁定均有服务与真实 Electron 证据 |
| Graph v2 核心与扩展验收 | ✅ | 300 文件/1279 节点、纠错/stale/failure live、AX/键鼠、布局/性能、重启/A→B 均有行为证据；韧性批关闭语义权威、不可变快照与异步所有权，复审 P0/P1/P2=0，当前签字总链为 0.0W 的 32/32 |
| Diagnostic Preview / Export | ✅ | 设置页精确预览、递归脱敏 allowlist、token-only IPC、原生保存和不可覆盖 0600 写入均已接入；Service 13/13、Handler 10/10、Renderer 7/7、真实 Electron 可见旅程通过 |
| 来源、PDF、脚注 | ✅ | 本地证据地基和可审查建议已接入 |
| AI metrics | 🟡 | 真实 GUI 已验证项目内记录、聚合与落盘；项目切换隔离有专项动态证据，仍待真实作者样本 |
| Research / A–D 溯源 | 🟡 | Main-owned Research→Changes v1 与 committed-warning 异常边界已签字；A–D 非事实背书，仍待真实作者准确率样本 |
| image-01 插图 | 🟡 | 安全落盘、尺寸证明、1–5 分、可选费用、插入/保留/可恢复废纸篓及项目聚合已接入；独立复审 P0/P1=0，待完整 API Key 真实验收 |
| 6→7 章 Electron E2E | 🟡 | 0.0W force 模式 32/32；仍待真实作者项目、真实 API 与干净账户/正式签名打包验收 |
| 10 名作者内测与 Continue 指标 | ⬜ | 尚无真实样本，不得做 Go/No-Go 结论 |
| 公开发布 | ⬜ | 待真实 API/作者验收、重新打包、签名、公证和 Gatekeeper 复审 |

## 4. 后续 TODO（严格顺序）

### P1：Chat/Chapter 独立复审阻断项（已关闭）

- [x] Chat：将 `selection` 与 `scope`、`project_prompt` 一样设为不可排除；Resolver 在策略过滤后再次确认精确选区完整进入模型。
- [x] Chat：preflight、LLM、Inspector/Chip 共用 request token；文件/revision/editVersion/selection/scope 漂移或后发请求会使旧结果失效。
- [x] Chat：Source 标题 locator 定位 Markdown 正文 H1，不再优先命中 Front Matter `title`；已有同名 YAML/Heading 点击回归。
- [x] Chapter：project/target/instruction/context/pending 与 transaction 绑定；每个异步边界复验，迟到 capability 按 origin 丢弃。
- [x] Chapter：旧 pending 阻止新 Chapter；no-op 与 review replacement 都不能清空/覆盖并发审阅，旧 finally 不干扰新请求 UI。
- [x] 独立复审后重跑完整 `npm test`、`npm run verify` 与强制 Electron E2E，均通过。

### P1：Onboarding v2 自动化与人工体验已关闭；随后迁移

- [x] Onboarding v2 独立底座：service 22/22、capability 15/15、all-or-nothing batch 22/22，均加入验证主链且各只出现一次。
- [x] Onboarding v2 Main/preload 定向契约：当前集成 **14/14**，覆盖 project switch/discard/residual/stale、post-commit token mint failure、batch commit 后 bookkeeping/tree refresh 失败仍保持 `ok: true` 与权威 `files`、独立 confirm/discard IPC，以及后续 watcher flush 边界。后续只需随总链做 Electron/回归，不重写契约。
- [x] **Renderer committed warning**：保留“磁盘已提交”真相，展示权威文件路径、Main 状态刷新异常、需重开项目及不要重复确认；动态对抗测试通过。
- [x] **Renderer 双授权 all-settled 回收**：`discardChanges` 同步或异步失败时仍执行 `discardOnboardingConfirmation`。
- [x] **验证主链接入**：dynamic 在 `verify` 恰好一次、`preverify` 零次；Renderer state/UI 为 8/8、11/11，dynamic 当前为 25/25。
- [x] **向导销毁后的异步焦点**：所有 rAF focus 回调执行时复核 `destroyed`；deferred `onGenerate → destroy → resolve` 已证明不调用 `onComplete`、不重渲染、不夺焦点。
- [x] Onboarding v2 fixture/API/Electron：完整 `npm test` 与沙箱外 `npm run verify` exit 0；**20/20** 是该链历史专项 Electron 证据，当前签字项目总链为 0.0W 的 **32/32**。它证明 malformed 保留答案且不自动修复、第一次确认只更新 `edit.md`、第二次确认才原子创建 Main 模板、冲突零部分写入且 token 终止。
- [x] **当前源码 App 三项人工复验**：隔离六章 fixture 中，Malformed JSON 后回答保留并可重试；第一次接受真实写入磁盘 `edit.md` 且第二阶段前初始文件零创建；合法 `edit.md` 顶部不显示“需修复”。
- [x] Research→Changes 产品链：建立 `writcraft.research-handoff/v1`，Main 按 card ID 重建 source revision/quote/locator，把来源绑定为只读依赖并进入 provenance；独立实现复审 P0/P1=0、全量 verify exit 0；**20/20** 是含 reject/A→B 的历史专项 Electron 证据，当前签字总链为 0.0W 的 **32/32**。0.0U App 人工 Research→Changes→History/undo 通过。
- [x] Inline Rewrite 自动化链：`end_turn`/严格 JSON、输出边界、保留路径禁写、Main capability/ACK、durable reconciliation、全局 mutation guard、接受时依赖复核、History/undo 与原位红绿 Diff 已完成；独立复审 P0/P1=0，**21/21** 是历史专项 Electron 证据，当前签字总链为 0.0W 的 **32/32**。
- [x] Inline Rewrite 当前源码 App 人工旅程：预览零写入、ACK 后交互、拒绝/重载、接受后磁盘与 History、Safe Undo 均通过。
- [x] Plan 生成只读路径补 strict JSON、stopReason、单文本块、错误脱敏、目标/Prompt 资源上限；独立复审 P0=0/P1=0，强制 Electron 覆盖失败→重试。

### P2：Chat/Chapter 独立复审保留的非阻塞测试增强

- [x] Chat：scope、selection、`editVersion`、Chat 重开与 workspace 权威状态变化会主动清空失效 preflight；request/phase 所有权保护新 preflight 与 actual。Chat 11/11、真实 Electron 28/28，最终独立复审 P0/P1/P2=0。
- [x] Chat 测试增强：Chat 重开、正文 collapsed selection 与 workspace invalidation 已各自进入真实 Electron；唯一问题/响应避免历史消息假阳性，Main `PROJECT_CHANGED` 先于 Renderer watcher 收敛的竞态也已动态关闭。
- [x] Chapter：no-op 与 provenance-invalid 已抽成生产复用分类器和动态测试；绑定完整 provenance、inner/outer capability 与唯一 file review，确认式回收并防重复 discard。Chapter 17/17、Proposal Transaction 23/23，最终独立复审 P0/P1/P2=0。
- [x] Onboarding Main：生产 handler **6/6** 动态覆盖并发、pre-model live authority、TTL、真实 Pending ChangeSet eviction 与项目/generation drift；rollback cause chain 显式锁定为 `ROLLBACK_FAILED → COMMIT_FAILED → force rollback`。完整 test/verify 与 Electron 28/28 通过，独立复审 P0=0/P1=0。
- [x] Onboarding 成本优化：同项目 single-flight 已确保并发空闲请求只产生一次付费模型调用；owner-only `finally`、Renderer navigation epoch 与页面生命周期 exact-project cleanup 已覆盖 await→mint 和 mint→IPC delivery 两侧竞态。Handler 11/11、Main/preload 14/14、完整 test/verify 与 Electron 28/28 通过，最终独立复审 P0/P1/P2=0。
- [x] Research→Changes committed-warning：生产事务 11/11 动态覆盖真实 apply/History、post-commit stale/TTL、residual put/finish/tree、reject-only、conflict、History rollback、旧能力防重放与 undo；最终独立二审 P0/P1/P2=0。
- [x] Plan Main handler 动态白盒：已抽出 `src/main/project-plan-handler.js`，实际 IPC 注册复用该 factory；Plan handoff 15/15 直接执行生产 factory，覆盖 rejected result、success cache、模型返回后的项目/generation stale 与异常→`projectFailure`，并逐项锁定 Main 十项依赖注入。独立复审 P0=0/P1=0/P2=0。

### P2：Graph 既有韧性缺口（代码与独立复审已关闭）

- [x] Graph：已补 deferred-promise 运行态回归，覆盖 A→B、persist 中切项和同项目后发 refresh 对旧 resolve/reject 的 supersede。
- [x] Graph：Graph Index 已从 Main 权威文件快照重建 canonical contribution，缓存和 injected analyzer 的 evidence/完整语义都必须精确匹配。
- [x] Graph：Renderer Graph/Node 已固化为有界 clone + recursive freeze；非法快照 fail closed，WeakMap 派生不再接受原地突变。
- [x] Changes/History：`history_failed_rollback_failed` 已进入 durable reconciliation/manual-recovery；Main/IPC/Renderer、两项人工恢复、同动作重试与真实 Electron 30/30 均已签收。

### 当前全链复验门禁（Changes/History 0.0J 已关闭）

- [x] 在最终 Graph 0.0I 源码上重跑完整 `npm test`，exit 0；所有 Graph 定向与独立二审通过。
- [x] 在同一最终源码上重跑 Electron-enabled `npm run verify`，exit 0，真实 DOM sanitizer 13/13。
- [x] 随后重跑 `WRITCRAFT_E2E_FORCE=1 npm run e2e:electron`，30/30。

### P1：Research Accuracy v1（已签字）

- [x] 判断事务在推进 mutation generation 前完成 active mutation、exact owner/READY lease 与 live authority 校验；无效、stale 或错误 owner 请求零 generation 副作用。
- [x] filename-less watcher 事件保持 fail-closed；metrics 原子提交前重验 source/card authority，提交后只允许 exact card 重绑。
- [x] watcher 持续重启失败进入 exact project instance/root degraded 门禁，阻止后续 AI、项目写入与 Changes apply；重新打开的新实例成功启动 watcher 后清除。
- [x] 关闭第三轮 degraded 旁路：Inline apply、legacy edit confirm、Graph Issue handoff、Inline reconciliation/clear 均在首个磁盘或私有 metadata 副作用前门禁；首次 legacy migration 无 currentProject 的既有流程仍可执行。
- [x] 修正同根重开：稳定 instanceId 不再使恢复成为 no-op；degraded 或 watcher 缺失时显式 restart，成功才清除门禁，失败继续锁定。
- [x] Renderer 只在 `recorded && handoffAvailable && evidenceChanged === false` 时解锁；recorded-but-locked 会禁用来源、判断与 Changes，并禁止旧卡片重试。
- [x] 最新定向套件通过：transaction 10/10、watcher health 4/4、Legacy migration 12/12、Inline integration 7/7、Graph Issue handoff 6/6、network boundary 13/13；此前 Sources UI 16/16、Sources race 5/5、Research Renderer 13/13、Metrics 18/18、Watcher 16/16、handoff 15/15、两组 integration 8/8 与 12/12 仍绿。
- [x] 将 reviewer 的真实 Main/IPC persistent-failure harness 固化进仓库；专项 3/3、标准 Electron 30/30、完整 test/verify 与最终独立复核 P0/P1/P2=0。
- [x] 完整 `npm test`、Electron-enabled `npm run verify` 均 exit 0；最终受控 `WRITCRAFT_E2E_FORCE=1 npm run e2e:electron` **26/26**。

### P0：修复 2026-07-19 手动验收阻断项

- [x] 隔离开发/E2E/真实用户的 Electron 最近项目恢复；普通启动不得自动恢复 `/private/tmp` 测试 fixture，并有真实 Electron 回归。
- [x] 为项目卡模型输出增加严格结构化生成、JSON 提取/字符串安全有界修复和最多一次受限重试；失败保留答案并提供“重新整理”。
- [x] 在缓存 ChangeSet 前验证完整 `edit.md` Front Matter，强制 `schema: writcraft.edit/v1`；旧 `v0` 只生成保留未知字段/正文的迁移 Diff。
- [x] 明确 Changes 预览与写盘边界，使用“确认并更新 edit.md”，成功后强制重读磁盘并聚焦；初始文件部分失败可续跑。
- [x] 展开 Front Matter 稳定错误码、真实行号、原因和“生成修复提案”；warning/结构歧义不会生成空 Diff。
- [x] 真实 Electron 覆盖无效 JSON、答案保留、预览零写入、确认落盘、部分创建续跑、重启保持、旧 schema 迁移与临时项目隔离。

### P0 历史基线与当前复跑

- [x] 该历史批次源码复跑：`npm test`、沙箱外 `npm run verify` 均 exit 0，force Electron E2E 连续两轮 26/26；Inline 与 Plan 独立复审均 P0=0/P1=0，Graph 性能批独立复审 P0=0/P1=0/P2=0。后续 Graph 韧性修改后的当前门禁见 0.0I，不得混用。
- [x] 复验 A→B 项目切换时 metrics、Research、image 的延迟结果都不污染 B。

### P1：Phase B 分块修改与 Plan 交接（已关闭）

- [x] 冻结 `writcraft.plan/v2` 和 identifier-only Plan→Changes 交接；Main 绑定路径/revision，限制缓存为 8 条/2 小时并阻止 source/target drift。
- [x] 每个待审阅提案分配独立 `pc_*` capability，避免同内容 ChangeSet 覆盖 provenance 或误丢弃新提案。
- [x] 实现稳定 hunk ID、逐块/整文件决策、默认 pending、部分提交 residual、拒绝审计与 revision 安全顺序撤销。
- [x] 真实 Electron 覆盖三块接受/拒绝/待定、residual 续审、两批撤销，以及 Plan 任务人工接受后落盘。

### P1：Graph 产品闭环与扩展验收（已关闭）

- [x] 冻结 `writcraft.graph/v2` 的 Node / Edge / Evidence / Issue 契约；完成稳定 block/content 锚点、增量缓存和五类核心诊断。
- [x] 增加作者纠错闭环：合并别名、确认/否定事实、编辑属性；决定持久化并作为下一次抽取约束。
- [x] 将“建议修复”升级为结构化 Issue→Changes：绑定 `issueId`、证据 revision、目标范围和来源关系，stale 时阻止生成/应用。
- [x] 补齐 `claim_conflict`、`unresolved_foreshadow`、`orphan_entity` 与人物/变量/关系的跨文件演化表达。
- [x] 完成扩展验收审计并冻结 `GRAPH-ACCEPTANCE-V1-CONTRACT.md`：当时确认真实 Electron 仅完整覆盖 Issue→Changes，并据此列出筛选、双证据、stale、作者纠错、键盘/AX、最小窗口和性能的动态证据缺口；下一项已全部关闭这些门禁。
- [x] 用真实 Electron 覆盖人物/变量/时间筛选、冲突双证据、stale Evidence、作者纠错与结构化修复交接；补可访问性、布局和大型图谱性能复审。该 Graph 性能批强制 Electron 连续两轮 26/26，独立复审 P0=0/P1=0/P2=0；当前签字总链为 0.0W 的 32/32。

Graph Extended Acceptance v1 已签字。首轮复审曾以 P1=3 回退 watcher、cold-to-interactive 与 AX/failure-live；2026-07-23 性能复验进一步关闭索引、布局、baseline DOM 与可见帧计时缺口，该批源码全量 test/verify、强制 Electron 连续两轮 26/26 通过。后续 0.0I 韧性批已完成代码、定向测试与独立复审，并在当前签字的 0.0W 强制 Electron 32/32 中再次通过后续 Graph 用户旅程。

### P2：补齐真实 API 与作者证据

真实作者与付费网络的允许证据、隐私边界、必跑旅程和签字顺序已经冻结在 `../docs/AUTHOR-ACCEPTANCE-V1-CONTRACT.md`；stub、fixture、源码字符串或单次成功调用均不能替代该合同。

- [x] 冻结 `AUTHOR-ACCEPTANCE-V1-CONTRACT.md`：定义 2000+ 字/5+ 章真实项目、付费网络双门禁、允许记录的脱敏证据、五段必跑旅程和发布前签字顺序。
- [x] 加固并签字真实 API acceptance 离线合同：Onboarding service 成为唯一 JSON 解析权威，稳定错误码保持可分类，image 报告解码尺寸/比例；凭据优先级、显式 profile 排他且 fail-closed、未知 scope、双门禁、无 Key、阶段顺序、恶意异常脱敏与失败清理动态 **15/15**，0 网络。它不等于真实付费 API 已执行。
- [x] 完成真实作者项目只读预检与隔离副本技术候选：**历史** 0.0O 为 Author **42/42**、0.0S 为 **47/47**；0.0U 签字基线为 **48/48**，新增 0755 pre-open replacement 零副作用拒绝及 shared/setgid 父目录兼容回归。
- [x] **历史** 0.0O 第六轮独立技术复审为 **P0=0/P1=0/P2=3，可以代码签字**；0.0P 已移除 Python 运行时 P2。0.0S 合计 **62/62、0 网络**，第三轮独立复审当时为 **P0=0/P1=0/P2=3**；Plan timing 已由 0.0T 关闭，reserve 副作用与威胁模型已由 0.0U 收口。当前按顶部 0.0W 下一本地任务或显式外部门禁续作。
- [x] 将 `/usr/bin/python3 -I` 替换为随 App 打包的 universal 原生 author-copy helper；0.0S 将 build signature 纳入 recipe，并串联 attestation→App helper→ZIP helper/完整 App tree。0.0V 已把 project-hash helper 纳入同一双-helper链，0.0W 当前 ad-hoc App/ZIP 通过 package **8/8**、release **7/7**，仍禁止分发。
- [x] 将 Onboarding/Graph 外部变化等待从 generation 静默窗口升级为 Main-owned exact watcher barrier；0.0Q 最终 Watcher 23/23、跨层 11/11、聚焦 2/2、同源完整 Electron 连续两次 32/32。
- [x] 将 strict watcher hash 改为 no-follow fd，打开后复核 inode/size 并有界读取，关闭 `lstat→path read` 最终文件组件并发替换 P2；0.0R Watcher 28/28、跨层 11/11、同源完整 Electron 连续两次 32/32，最终组件范围已签收。
- [x] 0.0S 已关闭 reserve 成功后 stdout/status 丢失的未知空 stage 与 build 因果：receipt 失败不猜测清理，身份已知失败只作 exact recheck 清理；标准打包 attestation 已贯穿到完整 App tree。不得把这写成全路径 TOCTOU 已消除。
- [x] 0.0T 关闭首次 Plan write timeout：保留历史红灯，以挂起式重复 refresh 回归稳定复现，修复后 Renderer **25/25**、三次真实 Electron **32/32**，独立复审 **P0=0/P1=0/P2=0**。
- [x] 0.0V 祖先逐段 `openat` 已签收：worker 10/10、Watcher 30/30、cross-layer 11/11、Large 6/6、package 8/8、release 7/7、全量 test/verify、Persistent 3/3、Electron 32/32；独立复审 P0=0/P1=0/P2=2。其当时的 payload metadata 下一任务已由 0.0W 关闭；初始根外层祖先仍开放，0.0U 同 UID 0700 reserve residual 则已明确接受，二者不得混写。
- [x] 0.0W 已关闭 payload metadata P2：JS/native 同为精确 16 MiB 完整请求上限，worker 12/12；全量、Persistent 3/3、Electron 32/32、package 8/8、release 7/7 通过，独立复审 P0=0/P1=0/P2=1。唯一 watcher P2 为初始项目根外层祖先 TOCTOU。
- [x] Author Evidence Metrics v1 已签字：service **13/13**、integration **6/6**、Renderer **18/18**、Onboarding dynamic **22/22**、Workspace **19/19**、image **8/8**、Research **13/13**、Plan **16/16**、Graph handoff **6/6**；该 Metrics 批完整 `npm test`、Electron-enabled `npm run verify` 均 exit 0，强制 Electron **26/26**，独立复审 **P0=0/P1=0/P2=0**。成功 Onboarding 指标延迟到 exact capability 终态后落盘；并发释放、失败重试、项目切换与 post-commit confirmation token 清理均已关闭；当前签字总链为 0.0W 的 32/32。
- [x] 使用可控、开发态双门禁且未知请求 fail-closed 的 stub 完成 Research GUI：选择来源 → Claim/Source/Boundary → 制造 stale → 阻止 Changes → 重跑 → 人工确认交接。
- [x] 使用同一 stub 完成 Image Review GUI：完整 PNG 解码与比例证明 → 预览零正文写入 → 必填评分 → 显式插入/保留/废纸篓；动态三态、失败重试与真实 Electron 插入/保留均通过。
- [x] 在真实 GUI 中完成 metrics 项目内记录、聚合刷新与私有文件落盘；A→B 的 origin/path 隔离由现有 renderer/Main 专项动态验证。
- [x] 用用户显式配置的 Key 完成真实 `/models` 与最小 `/messages` 握手；设置只显示脱敏状态、模型可用性和延迟。
- [x] 用合成内容完成真实 MiniMax 项目卡提案与 Research 证据卡验收；记录延迟、结构化结果、quote 修复和磁盘零修改，不记录秘密、正文或模型原文。
- [ ] 使用完整 `sk-api-` 人工验收 image-01：记录延迟、限流、超时、故障提示、图片质量与费用，但不记录秘密、Prompt 或 base64。
- [x] 为 `.writcraft/image-trash/` 增加可见恢复/清空入口与明确保留策略；V0 不自动永久删除，恢复/清空只走 Main 精确能力与真实 Electron 用户旅程。
- [x] Image Trash 最新 21/21 竞态加固最终独立复审：P0=0/P1=0/P2=1，可以签字；P2 为非阻断 external open-FD residual。
- [ ] 在真实 GUI 完成“项目卡 → edit.md ChangeSet → 人工确认 → 磁盘落盘”，并以真实作者项目记录结构化输出失败率与修复重试结果。
- [ ] 由作者显式选择合格项目，运行 `acceptance:author:prepare` 并只在隔离副本中完成五段真实旅程；当前最近项目预检不合格，禁止扫描其他私人目录补位。

### P2：Main 网络与安全审计

- [x] 列出 Main 唯一允许的远端主机和代码路径；Renderer CSP/session 双重断网并拒绝权限。
- [x] 加固可信 sender、project instance/revision、请求/响应上限、timeout/owner abort、零 POST retry、拒绝 redirect 和稳定错误脱敏。
- [x] 区分 Main 内部 revision 回声与真实外部修改；修复引用双阶段导入自我失效和 FSWatcher 异步 error 崩溃风险。
- [x] 独立复审 Research 的“元数据声明≠事实背书”和 image 的“预览≠插入”；真实 Electron 覆盖人工确认与显式插入。
- [x] 增加恶意 Markdown/恢复 HTML 的真实 Chromium DOM sanitizer 专项；覆盖清洗、插入、二次解析、namespace、URL、DOM clobbering 与超量节点 fail-closed，当前 **13/13**。
- [x] 固定正式 userData、完成受限一次性迁移与 E2E profile 隔离；握手和真实验收脚本默认离线、显式门禁且输出脱敏。

真实验收命令（只有显式门禁才联网）：

```bash
WRITCRAFT_REAL_API_ACCEPTANCE=1 npm run acceptance:api
WRITCRAFT_REAL_API_ACCEPTANCE=1 WRITCRAFT_REAL_API_SCOPE=image WRITCRAFT_REAL_API_IMAGE=1 npm run acceptance:api
```

第二条需要完整 `sk-api-`；Coding Plan Key 会在本地预检阶段返回 `IMAGE_KEY_UNSUPPORTED`。

### P3：真实作者闭环

- [x] 在 Sources 为 Research 证据增加明确的“主张匹配 / 不匹配”作者判断并纳入私有聚合；Research Accuracy v1 已完成第四轮独立复审与全量签字，且作者判断不得冒充平台事实评分。
- [ ] 使用真实作者项目取得 Research 准确率样本；自动化判断与 fixture 不得替代作者证据。
- [ ] 图片质量评分与账单费用只在真实 `image-01` 人工旅程记录安全枚举/数值；自动化不得臆测质量或费用。
- [ ] 用真实 2000+ 字、5+ 章项目跑项目定义 → 写作 → Research → 插图 → 跨文件 → 图谱 → 重启恢复。
- [ ] 得到真实 inline 接受率、Plan 使用、Research 准确率和图片采纳样本后，再决定是否进入 10 名作者内测。

### P4：打包与发布复审（最后做）

- [ ] 上述验收与独立复审通过后，基于当前源码重新打包，运行 `npm run release:verify`。
- [ ] 在干净 macOS 环境从 Finder 启动，验证 API Key 入口、PDF runtime、本地资产、重启恢复和无开发依赖。
- [ ] 公开发布前完成 Developer ID、hardened runtime、时间戳、公证、staple 和 Gatekeeper；轮换曾暴露的 MiniMax Key。

## 5. 下次不要做

- 不要把 `npm run verify` 全绿写成真实 API、用户价值、安全或发布已验收。
- 不要把 Research A–D 展示成平台对真实性的评分，也不要在 use-time revision/quote 重验前跳转或交给 Changes。
- 不要让 metrics 记录正文、Prompt、模型回答、API Key、绝对路径或未知字段，也不要使用完成时的“当前项目”替代 origin。
- 不要让图片生成成功后静默插入正文，不要把短期远程 URL 当项目资产。
- 不要重打包旧源码、分发现有 ZIP 或复用历史测试数字。
- 不要把右侧 Diff/ChangeSet 预览描述成已经修改磁盘；只有明确应用成功并重读 revision 后才能显示“已更新 edit.md”。
- 不要让普通启动复用测试 fixture 的最近项目记录，也不要通过自动写入来掩盖项目卡提交入口不清晰的问题。

## 6. V0 完成定义

“V0 完成”必须同时满足：PRD §10、当前源码完整自动回归、真实 5+ 章 Electron 全链、真实 API 人工验收、Main 网络/安全与打包发布复审、独立复审无阻断项，以及真实内测指标支持 Continue。在此之前统一使用“候选原型”或“待人工/发布验收”；只有当次完整自动化实际通过时，才可写“自动化全绿，但仍待人工/发布验收”。
