# 笔触 · WritCraft 当前开发状态

> 最后更新：2026-08-03（0.2.0 发布执行中；本地产物与自动门禁已通过）
> 当前公开版本：`writ-craft@0.1.2`，npm `preview`
> 当前代码版本：`v0/package.json` 为 `0.2.0`
> 下一候选版本：`0.2.0` 日常写作工作区
> 当前阶段：**0.2.0 发布门禁已获授权，正在执行 npm/GitHub/Tag/Release/App ZIP 发布**

本文件只记录当前事实、开放风险和下一动作。0.1.x 的完整里程碑、红灯、测试数字和验收过程已归档到 [`docs/archive/development/DEVELOPMENT-STATUS-THROUGH-0.1.2.md`](../docs/archive/development/DEVELOPMENT-STATUS-THROUGH-0.1.2.md)，不得从归档旧 TODO 直接派发工作。

## 1. 权威入口

1. [`docs/ROADMAP.md`](../docs/ROADMAP.md)：唯一版本顺序和正式范围。
2. [`docs/ROADMAP-0.2.0.md`](../docs/ROADMAP-0.2.0.md)：0.2.0 已批准详细合同、阶段顺序和验收门禁。
3. 本文件：当前代码、开放风险和下一动作。
4. [`docs/WRITCRAFT-PRD-V3.md`](../docs/WRITCRAFT-PRD-V3.md)：长期产品契约。
5. [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)：稳定架构与维护边界。
6. [`docs/INDEX.md`](../docs/INDEX.md)：按任务选择需要阅读的合同，禁止全量读取历史文档派工。

源码与可复现测试优先于文字快照。任何文档冲突先校准文档，再继续开发。

## 2. 0.1.2 已发布基线

- npm：`writ-craft@0.1.2`，`preview: 0.1.2`，`latest: 0.1.0`。
- registry shasum：`553bec35246b118ae5a47b2d4dd327c16c171029`。
- GitHub prerelease：`https://github.com/MaxHou-infinity/WritCraft/releases/tag/v0.1.2`。
- annotated tag `v0.1.2` 解引用到发布提交 `395b863`；文档收口提交为 `95f923b`。
- 不提供未签名 App/ZIP；独立 macOS App 签名与公证不是当前路线。
- 0.1.2 已冻结。后续生产修复使用新版本，不回写或重新发布 0.1.2。

已签收的用户能力：

- 本地多文件项目、`edit.md` 项目 Prompt、文件树、标签和恢复；
- 项目卡、Inline `⌘K`、Chapter、Chat 与 Context Inspector；
- Changes/Diff、History、冲突阻止和 Safe Undo；
- 空项目结构规划、已有稿件写作导航和统一写作任务流；
- Sources、Research 高级独立流程、Graph v2 与 Issue→Changes；
- 图片生成、评分、prompt-free 插入、保留和安全删除终态；
- Markdown 回收区、诊断预览、npm Developer Preview。

以上能力除非 0.2.0 生产源码直接影响，不重复进行 0.1.2 的项目卡、接受/拒绝/撤销或付费作者验收。

## 3. 当前开放项

### P0 / P1

- 0.2.0 最终独立复审为 P0=0、P1=0；当前无工程阻断项。

### 0.2.0 阶段 F 候选事实（2026-08-03）

- 当前会话 pending review 的真实 Electron 动态矩阵 3/3 通过：覆盖公开 `review_*` 身份 hydrate、丢弃、接受/拒绝、residual 新身份、旧身份失效、真实 TTL 过期、首页入口消失和正文零写入。Renderer 的 public ID 仅用于审阅决策，真实 ChangeSet capability 始终由 Main 解析。
- 作者授权源稿通过生产 copy transaction 创建隔离副本 `WritCraft-0.2.0-作者验收-1`：20 个 Markdown 文件、12 个正文文件；源摘要在复制前后完全一致。Computer Use 在独立 profile 中完成“首页查看状态 → 继续写作定位 → 查看当前文件大纲 → 返回首页”，无 AI、无付费调用，源稿和副本的非私有文件最终逐文件一致。
- 真实旅程发现并修复 P1：从首页打开最近文件时正文已经切换，但大纲仍描述旧文件。现在 Home 打开动作必须等待目标文件大纲刷新，再恢复正文定位；Computer Use 复验确认目标标题出现、旧大纲消失，返回首页后继续位置和 pending=0 正确。
- 最新源码 `npm test` 与非沙箱完整 `npm run verify` 通过；待审 focused Electron 3/3 通过。Daily Workspace focused 复跑再次在“外部文件 watcher 大纲刷新等待”处红灯；该非固定 harness 时序问题已保留为 P2，未用重跑绿灯覆盖。确定性 watcher/owner 专项、真实作者 UI 旅程和此前 focused 证据均通过，未形成稳定产品回归。
- 最终独立复审：P0=0、P1=0、P2=2，可进入候选。P2-1 为缺少“`refreshOutline` await 期间切项目”的 mutation-sensitive 专项，生产实现已有 refresh 后 owner 复核；P2-2 为通用 store 配置超过 10 项时 public projection 可能隐藏最旧映射，生产 Main 上限与 projection 同为 10，当前不可触发。两项均允许候选，未来触及对应代码或提高上限时必须先补合同和反例。
- 所有者于 2026-08-03 完成唯一一次最短主观旅程并明确回复“验收通过”。至此工程门禁、真实作者客观旅程和作者主观体验均已关闭，0.2.0 候选验收完成。未经另行授权，仍不发布、不打 Tag/Release、不推送或分发 App/ZIP。

### 0.2.0 发布执行记录（2026-08-03）

- 所有者已明确授权：执行 npm `preview`、GitHub 推送、`v0.2.0` Tag/Release，并上传 App/ZIP 产物。
- 发布前自动门禁：`npm test`、非沙箱 `npm run verify`、`npm run release:verify`、`npm audit --omit=dev` 均通过；npm tarball dry-run 为 `writ-craft-0.2.0.tgz`，140 个文件，683,229 bytes。
- 本地 macOS 产物：`v0/release/WritCraft-darwin-arm64.zip`；当前为 ad-hoc 本地签名、未公证，不宣称 Apple Developer ID 分发能力。
- 本节在 npm/GitHub 动作完成后补录 registry shasum、dist-tag、发布提交、Tag、Release URL、ZIP SHA-256 和最终时间；在补录前不得把候选写成已公开。

### 0.2.0 阶段 E 当前事实（2026-08-03）

- `writcraft.workspace/v2` 已实现并由 Main 独占迁移写权限：合法 v1 原子迁移；损坏、未来 schema 或失效路径安全降级且不覆盖原记录。保存/读取均绑定 exact `projectInstanceId`；保存 generation 由 preload 单调签发并由 Main 拒绝旧请求。
- 标签、当前文件、caret、selection、scroll、当前/折叠大纲和最多 32 项 `returnStack` 已持久化。返回时 revision 相同精确恢复，漂移时只恢复安全位置；临时 pending capability/location 不落盘。
- 项目首页、深跳与返回动作均绑定项目实例和 operation generation。真实 IPC 反例覆盖同项目旧异步保存落后于 close flush、保存执行中切换项目、旧项目 load/save、返回动作与首页 resolve/back 跨项目迟到；均不得覆盖新项目状态。
- 真实 Electron 性能复验：50 文件五次 `576.8 / 583.3 / 588.9 / 717.6 / 1169.4 ms`，max `1169.4 ms ≤ 1.5 s`；300 文件五次 `578.1 / 596.6 / 619.1 / 620.0 / 732.1 ms`，max `732.1 ms ≤ 3 s`。每次均为 fresh project/profile/process。
- 真实 `webContents.setZoomFactor(2)` 下 focused 工作区 2/2 通过，覆盖 Home → Continue → Return、`⌘P` 焦点/关闭、窄窗口键盘和项目切换 owner；不是用 deviceScaleFactor 冒充。
- `npm test` 与完整 `npm run verify` 通过；真实 Electron 曾完成 38/38 全绿。随后大型 harness 在不同旧路径出现三次非固定红灯（CDP evaluate、Chat fixture watcher 恢复、Recent return 等待），且曾在消除测试 sentinel 与真实滚动值冲突后再次 38/38 全绿；最后一次 owner 错误优先级修正后 focused zoom 2/2 通过，但全量复跑又在 Recent return 等待红灯。按纪律保留为 **P2 harness 时序不稳定**，不能用绿灯覆盖，也未发现稳定产品断言回归。
- 独立复审最终 P0=0、P1=0、P2=1。P2 为跨项目 in-flight 保存反例缺少 Main-side “delay 已进入” latch，当前依赖 Electron 同 sender IPC 顺序；实现本身已在 await 后重新取得当前项目并动态通过。阶段 F 若触及该 harness，应补 fixture-only latch，提高反例 mutation sensitivity。

### 0.2.0 阶段 D 当前事实（2026-08-03）

- 中央主工作区新增项目首页；左侧活动栏提供常驻入口。已有项目仍恢复上次编辑位置，新项目进入首页。首页只消费 Main `writcraft.project-home/v1` 快照，不在 Renderer 扫描正文或推断完成度。
- 首页包含继续写作、当前会话待审 Diff、最近修改、Graph/显式来源缺口和正文一览；所有入口都通过 Main stable locator 解析。revision 在 resolve→open 之间漂移时只重解一次，持续漂移明确失败；首页可响应 tree/current-file 权威变化重新加载。
- 新增 pending review 无 capability hydration：preload/Renderer 只传 public `reviewLocationId`，Main 负责 hydrate/apply/discard 并把 residual review 重新映射为新的 public location。过期、项目切换、迟到 hydration/discard 和 discard 失败均不污染新项目或伪报成功。
- 真实 Electron focused 2/2 通过，动态验证首页返回精确文件/光标、继续写作和最近修改卡片跳转；`npm run verify:daily-workspace`、Changes review UX 12/12、`npm test` 均通过。
- 完整 `npm run verify` 沙箱首跑在真实 DOM sanitizer 以 Electron `code=null` 退出；同一命令在获批非沙箱 GUI 环境原样复跑通过。误用旧环境变量的一次 38 阶段 harness 在首页阶段通过，随后于既有 Graph 冷重建时序断言红灯；保留为既有大型 harness P2，不归因于首页产品代码。
- 独立复审先后发现 hydration owner、discard 失败误报、返回光标缺失和跨项目 discard 迟到污染等 P1，均已修复；最终 P0=0、P1=0。
- 阶段 D 当时保留的 pending 动态矩阵缺口已在阶段 F 以真实 Electron 3/3 关闭。超过 10 项 projection 的通用配置风险仍作为允许候选的 P2 保留；生产 Main 上限与 projection 同为 10，当前不可触发。

### 0.2.0 阶段 C 当前事实（2026-08-03）

- 新增独立 `writcraft.document-outline/v1` 投影：Main 公开当前文件 revision、稳定 section ID、层级/父级、occurrence、UTF-16 区间与不透明 locationId；最多 1,000 标题、512 KiB，最终 partial envelope 按完整字节预算。
- 左侧 Explorer 已加入“当前文稿”标题树；支持层级缩进、会话内折叠、树键盘操作与 revision-bound 当前区块高亮。折叠持久化明确留给阶段 E 的 workspace/v2 迁移，没有向 workspace/v1 静默写新字段。
- 顶层 `⌘P` 快速打开已接通 file/heading/entity/issue；结果按类型分组，保持同一 input 节点、焦点、active descendant，IME composition 期间不查询，项目切换与迟到查询/激活结果均由 owner 丢弃。
- `pending_review` 的 Main 公开投影与 resolve 仍保留，但 Renderer 快速打开暂不列出。原因是 Renderer reload 或同会话多份 review 需要 Stage D 的无 capability hydration；当前宁可不展示，也不把“Main 仍有效”误报成可打开或已过期。
- 激活同一未保存/冲突/已删除正文时 fail-closed；打开文件后 revision 漂移最多回 Main 重解一次。大纲不从 breadcrumb 猜层级，不建立第二套文件扫描。
- 已通过：`npm run verify:daily-workspace`、workspace 持久化 10/10、Changes review UX 12/12、完整 `npm test`、真实 Electron focused 2/2。真实 Electron 已验证大纲目标的 Main source offset、编辑器 caret offset 和 `aria-current` section ID 精确一致，以及 `⌘P` 输入节点/焦点/方向键选择。
- 真实 IME 首跑保留红灯：composition 期间，组合开始前的在途查询曾迟到更新状态。修复为 `compositionstart` 同步失效旧 request owner 后，真实 Electron 复跑 2/2 通过，并验证 input 节点、焦点和状态在 composition 中不重建，compositionend 后才查询。
- 独立复审首轮发现 512 KiB 尾部 +1 byte、激活 owner、workspace/v1 漂移、滚动/revision 高亮和 pending 假可用等 P1；已逐项修正或按阶段边界从 Stage C UI 移除。新增 H1→H3→H4→H2 父链、精确 512 KiB 与 +1 byte 回归；最终复审 P0=0、P1=0、P2=0。
- 阶段 C 已关闭：真实 Electron 已验证外部磁盘修改后正文与大纲同步刷新；720px 下大纲抽屉可由键盘进入、激活和退出并恢复焦点；300 文件冻结 inventory 的 100 次逐键式查询不触发第二套扫描并通过 1.5 秒测试上限。
- 最终复审曾发现外部 watcher 回调跨 await 切项目时可能污染新项目及旧恢复对话框的 P1。现以 `projectInstanceId + currentPath + sequence` owner 约束 tree/edit/read/recovery 全链，并在项目进入开始时同步作废旧 callback；复审关闭为 P0=0、P1=0、P2=0。
- 完整回归首跑因旧 `verify-v0-project-entry-workspace.js` 截取函数时漏带新增 owner 计数器而红灯；确认属于测试夹具漂移，校准夹具后最终源码 `npm test` 全绿。该红灯不得被后续绿色抹除。

### 0.2.0 阶段 B 核心服务（2026-08-03）

- 已实现 Main-only `workspace-inventory-service` 与独立 Worker runner：确定性 Markdown inventory、标题索引、正文计数、章节状态、扫描前后项目权威复核和 5 秒硬终止。
- 已实现 `project-home-snapshot-service`：统一 authority vector、最近文件/章节/待审/问题/来源区块、严格 Sources 状态、2 MiB 有界 partial 响应；Graph、Source、Pending generation 在扫描前后必须一致。
- 已实现 pending public projection 与 `workspace-location-service`：公开结果不携带 root/capability/revision，resolve 时重新核对当前项目、inventory、revision、offset 和待审身份；公开列表淘汰不会删除底层 ChangeSet。
- `npm run verify:daily-workspace` 全绿；原 pending store 回归 14/14；多轮独立复审最终 P0=0、P1=0。
- 保留 P2：无 `Intl.Segmenter` 环境的 emoji fallback、inventory 16 MiB 总读取上限的 partial 策略、Home 输入 exact-key/plain-object 加固、Workspace Location TTL/候选流式化及 2 MiB 精确 `+1 byte` fixture。它们不得被误写为已关闭。
- Main handler、IPC/preload 窄桥已接通：完整 Home/Graph/Source/mtime 聚合在同一 5 秒可终止 Worker 内完成；Location 可独立冷启动；Graph entity/issue 与 pending 均由 Main adapter 解析；IPC 返回稳定 public envelope。
- 真实 Electron focused harness 强制启动后 2/2 通过：真实 preload→IPC→Main 首页/位置成功、实际项目切换后的旧 location 拒绝、oversized 项目的 watcher 稳定失败，以及 public payload 无 root/capability 泄漏。
- 真实组合红灯发现并修复：合法 `Graph:Unicode-路径.md` 曾被上下文解析器误判为 URI，导致 inventory 整体失败；inventory 现只复用 Markdown 标题 grammar，并以真实项目相对路径独立生成稳定 `sec_` ID。Worker runner 只公开 allowlist code 与固定文案，不再转发 Worker 原始 message。
- 最终源码后 `npm run verify:daily-workspace`、`npm test`、focused Electron 2/2 全绿；独立复审 P0=0、P1=0。阶段 B 已关闭，但 Renderer 产品界面尚未实现，因此仍不能称为 0.2.0 App 功能可用。
- 保留 P2：两次 38 阶段全量 Electron harness 分别在旧 Changes recovery 后的 CDP evaluate、旧 Markdown Trash 列表等待处红灯；相同源码的 Daily Workspace focused 均通过，暂归类为大型 harness 时序不稳定，后续阶段 E 治理。真实 Worker crash 的 IPC 脱敏由注入测试覆盖，尚未为生产增加 E2E 故障后门。
- 阶段 0 已通过实现、专项/完整回归、真实 Electron 与独立复审；这只表示技术基线完成，不表示 0.2.0 用户功能完成、候选完成或已发布。

### 0.2.0 前置技术卫生

以下历史路线遗漏已在 0.2.0 阶段 0 关闭：

1. **Main → Renderer 反向依赖已归零**：`block-anchor`、`context-selection` 已迁入 `src/shared/`；Main/Renderer 共用同一 UMD 实现。新增解析后的静态依赖门禁、Node/浏览器行为等价测试、Renderer script 与 npm tarball 断言。
2. **旧 Project Plan 已物理移除**：删除 11 个旧 Main/Renderer/测试文件，清除 Changes/E2E/package 残留；Chapter 内部区块规划、普通 Changes 范围预检、Research、Graph Issue 和历史 metrics 兼容保持可用。
3. **Navigation 已统一为 changes-only**：每张建议只签发一个 `changes` capability；依据链接直接使用 Main locator；`needs_sources` 仍回到同一任务，独立 Research 仍从 Sources 单独启动。
4. **Navigation 最大组合边界已闭合**：最大 2000 字/4096-byte goal、4096 evidence enum、最大 Unicode 输出与精确 1 MiB provider request 在同一 fixture 通过；`+1 byte` 在 provider 前以 `NAVIGATION_PROMPT_TOO_LARGE` 拒绝。
5. **复用既有能力**：`⌘⇧F` 保持全文搜索，`⌘P` 只做快速导航；共用 Main 索引，禁止第二套文件扫描。workspace 已能恢复标签、当前文件、光标和滚动，0.2.0 只增加选区、返回路径和安全 schema 迁移。
6. **限定待审 Changes 真相**：当前 pending ChangeSet 是进程内状态。项目首页只展示当前会话可验证的待审项；不得暗示重启后仍持久存在。

### 已分流的历史 P2

- Navigation/AI metrics 仍沿用部分历史 `plan/*` 字段：安排到 `0.3.0` 透明 AI 协作统一迁移；旧持久化事件保持可读。
- 图片 alt/caption 可编辑性与已保留素材清理：进入 `0.4.0` 媒体/交付候选池；不得在 0.2.0 重开 Image Trash。
- Research 准确率、图片价值样本和 10 名作者内测：属于 `1.0.0` Go/No-Go 证据，不是 0.2.0 功能门禁。
- Developer ID、签名、公证和 Gatekeeper：仅在未来选择独立 App 分发时启动。
- 同 UID 0700 reserve 微窗口及已记录 filesystem residual：属于明确接受的威胁模型残余，不得伪装成未完成 TODO。

## 4. 0.2.0 已批准范围

已批准的产品范围：

- 项目首页：最近工作、确定性项目摘要、当前会话待审 Changes、Graph 问题和已有来源诊断；
- 当前章节大纲：标题层级、当前位置跟随和准确跳转；
- `⌘P` 快速打开：文件、标题、实体、问题和当前会话待审对象；
- 可恢复导航：复用现有 workspace 状态，补选区、返回路径和失效定位降级；
- 自动化优先验收与一次最短作者主观旅程；
- 0.2.0 新增或实质修改代码的健壮性、关键注释、JSDoc/合同和反例测试。

明确不做：AI 任务中心、`@` 引用、统一 Prompt 编译、云/协作、多模型、Graph 重做、AI 语义搜索和大纲拖拽改写。

### 阶段 0 验证证据

- `npm test`：通过。
- `npm run verify`：沙箱内首次在真实 DOM sanitizer 以 Electron `code=null` 退出；相同探针在获批非沙箱 GUI 环境 13/13 通过，随后完整 `npm run verify` 通过。红灯保留为环境分类证据，不以绿色覆盖。
- `WRITCRAFT_E2E_FORCE=1 npm run e2e:electron`：真实 Electron 37/37 通过，含 Navigation → inline Diff、接受/Safe Undo、独立 Research 与零 Renderer 网络。
- 独立复审初次发现 P1=3、P2=1：精确 1 MiB 组合 fixture、依据链接真实点击、文档同步和 npm script 递归检查；均已补齐并定向复跑。最终复审 P0=0、P1=0。

### 阶段 A 合同证据

- 新增 `docs/DAILY-WORKSPACE-V1-CONTRACT.md`，冻结单一 Main 快照、生产 envelope、authority vector、正文/章节确定性统计、区块状态、Workspace Location list/resolve、pending public projection、stableLocator、workspace/v2、returnStack、5 秒降级和 50/300 文件性能口径。
- 只读源码审计确认：现有 tree/read revision、标题解析、Graph/issue、Sources、pending store 与 workspace/v1 可复用；字数、章节状态、pending summary、统一 locator、selection/return path 和 close flush 属于阶段 B–E 的真实实现缺口。
- 独立复审首轮 P0=0、P1=4、P2=2；后续复审继续发现生产 envelope、authority vector、临时 locationId 持久化和任意正文返回位置未闭合。全部在合同中修复；最终复审 P0=0、P1=0，最后一个 outline ID 边界 P2 也已补入冻结合同。
- 阶段 A 只修改合同/状态文档，未制作假数据 UI、未新增产品写入权限、未运行付费调用。

## 5. 下一动作（严格顺序）

1. 当前版本没有剩余 P0/P1 开发任务；0.2.0 候选验收已经完成。
2. 两项允许候选的 P2 不主动扩大本轮：只有触及 `refreshOutline` owner 测试时补 deferred 反例；只有提高 pending 上限时重做 public projection 合同。
3. 后续发布、版本号、npm dist-tag、Tag/GitHub Release、推送或 App/ZIP 分发均属于新的外部动作，必须由所有者另行明确授权。

## 6. 本轮文档治理结果

- 旧 Project Plan 合同、Phase A 长规格、0.1.x 完整状态账本、早期 PDCA 和 0.1.1 发布说明已移入 `docs/archive/`。
- `docs/INDEX.md` 成为文档选择入口；`docs/ARCHITECTURE.md` 接替 Phase A 中仍有效的工程边界。
- 0.1.2 作者验收、图片合同、首次使用指南、PRD、正式路线图和 `AGENTS.md` 的过时状态已校准或列入同批校准。
- `raw/` 与 `deliverables/` 只作研究/历史输入，不得派发当前任务。

## 7. 续作纪律

- 新会话只先读 `docs/ROADMAP.md`、本文件、`docs/INDEX.md` 指向的相关合同和 `v0/package.json`。
- 归档文档只能用于追溯“为什么”，不能回答“下一步做什么”。
- 不从未勾选的历史 checklist 派工；先确认本文件仍将其列为开放项。
- 红灯不能被绿色重跑抹除；当前状态只保留仍有决策价值的红灯，完整过程在归档账本。
- 关键里程碑同步本文件、相关合同与 Nowledge Mem；真实稿证据只保存内容无关字段。
