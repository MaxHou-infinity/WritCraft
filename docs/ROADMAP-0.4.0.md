# 笔触 WritCraft 0.4.0 开发路线图（生效合同）

> 路线图编号：`WRC-0.4.0-R1`
> 对应产品版本：`writ-craft@0.4.0`
> 版本主题：证据与交付闭环
> 起草日期：2026-08-06
> 批准日期：2026-08-06
> 当前状态：**阶段 0 已签收；阶段 A 当前推进 A1b，两个 P1 已关闭（fresh R publication identity、Main formal mixed rollback 出口），A1b 待一次完整独立复审后签收；阶段 B App 交付预检已完成并等待 A→B 重签，代码版本仍为 0.3.1。**
>
> **历史 focused 证据（不作为当前集成签收）**：production snapshot create、public-Markdown CREATE/RECONCILE/FINALIZE helper、Safe Undo Q/R/B/D/A native lifecycle、Safe Undo transaction 的 entryId→PRECREATE→Q/fresh-R→QUARANTINED query、B restart settlement 合同/schema、B→RESTORED transaction/restart、immutable undone-History template/materializer、QUARANTINED→HISTORY_COMMITTED、D/A restart finalization 合同/schema及其 production lifecycle/transaction/restart 编排、Changes/History artifact lifecycle、Main comparison、existing-leaf Restore、Main safe-delete service、full-missing Restore transaction/service、missing restore 的 exact-marker 合同/schema、Safe Undo private合同/schema、mixed Restore 高层 phase合同/schema、formal EXISTING executor 与 fd-rebuildable leaf identity 合同/schema、独立 `ROLLBACK_CREATE` 合同/schema、以及 Snapshot History ancestor + Safe Undo `RESTORED` phase 均为 P0=0、P1=0、P2=0；committed read/list、safe-delete storage、public-Markdown production adapter bridge 与 missing-leaf/SafeUndo 高层合同/phase schema 均为 P0=0、P1=0、P2=1；production exact-marker source/lifecycle 为 P0=0、P1=0、P2=4。同一 marker/WRCCHRA2 的 PRECREATE 与完整 HISTORY_COMMITTED transaction 层均为 P0=0、P1=0、P2=0。旧 exact-marker `CREATED_RECEIPT` P0=0、P1=0、P2=1 仅是 delegated checkpoint 未先执行首红的历史证据纪律记录，已由下方 permanent-journal CREATE 至 `CREATED_RECEIPT` 的当前签收取代，不再作为当前实现分级。详细项数、首红与 P2 见 `v0/DEVELOPMENT-STATUS.md`；当前基线以本页后面的“当前基线冻结”段为准。
>
> **永久 marker journal 合同/schema 与物理层**：同一 basename、稳定 inode、双 slot、generation/value-CAS、publication ARM、ACK_PREPARED 与 terminal IDLE 已独立签收 P0=0、P1=0、P2=2。两个 P2 仅为 pre-ARM hard crash 私有 stage 与 stale journal clone 的 fail-closed `UNKNOWN/manual` 可用性残余；都要求零公开 mutation、不收养或删除无法证明的 foreign。small native INIT/READ/APPEND/DISCOVER collaborator、ordinary service闭环及 Snapshot CREATE/History 至 `HISTORY_COMMITTED` 已接；96MiB实载、Snapshot finalize/cleanup、Main/App迁移仍未完成。

> **ACTIVE marker preimage amendment**：`ACTIVE`现持久完整descriptor-safe recovery marker preimage及3.1.4全文digest，restart不再依赖不可反演的摘要；legacy integrity与业务语义仍只由既有reconciliation validator消费时验证。该纯层独立签收P0=0、P1=0、P2=1；P2为95MiB cap/+1真实边界fixture尚未持久覆盖。
>
> **Missing-leaf CREATE journal capture**：normal `CREATE_MISSING` 的 post-facto capture合同/纯schema、CREATE domain重建桥与current-head独立pure wire均已签收；current-head层P0=0、P1=0、P2=0。helper 已被持久 attempt latch 标记但 capture 尚未落 journal 时的 crash/response loss仍是已接受的安全P2，固定为`UNKNOWN`/manual，禁止fresh R、restart或显式retry重新铸造authority或重CREATE。`CJ`命令只使用fd3 trusted root与fd4 artifact，绑定exact latched PREPARED publication及current ACTIVE journal head/frame/payload五slice，不再携带fd5 transient preimage；专属`WRCCHPC2`响应不放宽旧CREATE/Undo预算。300-item最大字段fixture已闭合395,434-byte响应、4,697,033-byte capture、4,699,529-byte frame及301拒绝。
> **Missing-leaf CREATE native/service checkpoint**：完整multi-item、fault/response-loss与300-item native/lifecycle层已独立签收P0=0、P1=0、P2=1；唯一P2是near-cap真实时间证据尚未持久化，安全P1已清零。C从physical head/frame/payload与五个canonical slices独立重算request、attempt latch、publication与command authority。Snapshot permanent-journal PREPARE→attempt latch→单次CJ→ARMED capture→COMMITTED→`CREATED_RECEIPT` service层复审为P0=0、P1=0、P2=0：prepare 2次、latch 1次、capture/phase 3次，共6次APPEND；latch与各APPEND响应丢失只fresh exact READ，已latched retry不重CREATE。focused41/41、journal read8/8、recovery24/24、high lifecycle63/63、CJ26/26、pure13/13均通过；整条CREATE路线仍继承pre-capture `UNKNOWN/manual`可用性P2。
> **Missing-leaf History journal checkpoint**：full-missing `CREATED_RECEIPT→HISTORY_COMMITTED` 已独立签收P0=0、P1=0、P2=0；复用 immutable History template/materializer、raw base/prepared authority与held parent durability，第7次APPEND响应丢失只fresh exact READ，base/prepared restart不重CREATE或正文，temp/file-fsync/rename/parent-fsync及foreign History均按可证明三态收敛或manual。focused52/52、journal read8/8、recovery24/24、History24/24、high lifecycle63/63、CJ26/26通过。
>
> **2026-08-10 Stage A 历史基线冻结**：上面较早的 Safe Undo D/A、`ROLLBACK_CREATE`、finalization/settlement 等“窄层签收”文字仅保留为历史 focused 证据；该基线当时止于 permanent journal ordinary 闭环与 full-missing Snapshot 的 `CREATED_RECEIPT→HISTORY_COMMITTED`。此后 A1a 已签收，A1b 已形成 journal 单权威、post-E CAS 与 mixed applied `FINALIZED→ACK→IDLE` 组件证据；当前事实以 `v0/DEVELOPMENT-STATUS.md` 为准，不得把本历史段恢复为派工红灯。

> **2026-08-10 Stage B App 最终验收（以本段为当前状态）**：delivery service **22/22**、schema 6/6、evidence 22/22、SourceIndex 10/10、shared marked 4/4、provider 9/9、handler 7/7、capability 7/7、IPC 4/4、ImageIO worker **8/8**；真实 Electron 隔离项目 **1/1**（已提交 snapshot、Markdown 字节零写入、无 HTTP(S) 请求、Renderer 不暴露 root）；`npm test` 与批准环境 `npm run verify` 均退出码 0，native strict Clang、Node syntax、`git diff --check` 均通过。footnote token/source-offset、health-root digest、Graph correction artifact、同一图片多引用与 Renderer loading-owner 已闭合。

> **Stage B 图片合同边界已闭合**：ImageIO helper 现接收 Main 保持打开的已验证 bundle fd 与 `writcraft.snapshot-entry-binding/v1`，native 以 `pread` 读取 exact entry，复核 bundle published identity/footer、entry offset/length、原始 SHA、object digest 与 binding digest，并在 decode 后再次复核 fd identity。PNG 另行执行 IDAT inflate/scanline/CRC/IEND 校验，JPEG 限制 single-frame baseline、Huffman/熵流/填充/EOI；CRC 合法但压缩流损坏的 PNG/JPEG hostile fixture 均由 native 路径拒绝。DOCX build/consume 属 Stage C，真实作者验收属 Stage E。

> 状态账本解释：本文件稍后仍保留的早期 Stage B 纯层/ wiring 段落属于历史 focused 证据；若其中出现 20/20、尚无 Electron 或“root projection 未完成”，均以本段和上方 App 增量段的当前数字与边界为准。

> **Stage B Main/IPC/Renderer 最终验收**：`delivery-preflight-handler.js` 已接入 `main.js` 的 `writcraft:project:delivery-preflight`、snapshot list/files 两个只读 IPC，preload 暴露同名窄桥，Sources 面板提供 snapshot/file 选择和只读 preflight 结果。Main 使用 committed snapshot worker、request-scoped snapshot provider、固定 TTL 的 opaque capability store；Renderer 只发送 `projectInstanceId/snapshotId/orderedFiles/warningDecision`，不发送 root/content/Graph/SourceIndex。定向证据：capability store 7/7、snapshot provider 9/9、Main adapter 3/3、handler 7/7（含 120 秒 owner deadline/abort）、IPC boundary 4/4；批准环境真实 Electron 1/1、`npm test` 与 `npm run verify` 通过。Stage B 完成不等于 0.4.0 全部完成：DOCX build/consume 属 Stage C，真实作者隔离验收属 Stage E；provider 对缺失、Graph identity 不匹配或未绑定/stale correction artifact 直接 stale/block，不会静默用 fresh graph 铸造 capability。

> **Stage B 后续边界**：上述 40 图/40Mpx worker 压力、storage-held bundle entry 绑定、native corrupt-draw 拒绝、footnote token/source-offset authority、Graph stale current locator、correction artifact fail-closed 与同一图片多引用逐一 token 绑定均已通过当前专项与 Electron 证据。当前只回到 Stage A，先完成 A0、A1a–A1c、A2a–A2d、A3，再以 App 创建的真实 snapshot 重签 A→B；只有这条连续链签收后才解锁 Stage C，Stage D/E 继续按顺序等待。capability consume 随 Stage C 导出事务接线。

> **仍未完成**：A1a CREATE finalize/ACK cleanup 已签收；A1b mixed applied 主线已经实现，两个 P1 已关闭：fresh R 消费 E 持久化的 control publication identity（`WRC_A1B_E3_R` 78/78），Main formal `UNCOMMITTED→ROLLBACK_CREATE Q/fresh-R/D/A→ROLLED_BACK` 出口已以真实 native production journey 接通（mixed journey 6/6）。完成一次 A1b 独立复审后，才可进入 A1c Safe Undo；A2 App 接线、96MiB实载、Snapshot helper package、A→B 重签以及 Stage C/D/E 仍按顺序等待。因此阶段 A 与 0.4.0 候选均未完成。

> **2026-08-11 封版恢复控制**：独立差距审计确认 Stage B 在 Stage A App 未完成时先形成纵切，现有 Electron 证据使用预制 committed snapshot，不能证明真实 A→B 用户链；Stage C/D/E 仍未开始，当前工作树也尚未形成 implementation candidate。执行方式切换为 [`WRC-0.4.0-EXEC-R1`](0.4.0-EXECUTION-PROTOCOL.md)：只推进 Stage A 的事务收口→App 纵切→顶级门禁→真实 A→B 重签；在这些门禁完成前冻结 Stage B 扩展并禁止 C/D/E 开工。该控制不改变本合同范围或已签收的 Stage B 纯层。

0.3.0 让 AI 协作变得透明、可取消、可审阅。0.4.0 的任务不是继续增加生成入口，而是让作者能够冻结一个可证明的作品状态、检查证据和交付风险，并把选定版本可靠地交给下一位编辑或读者。

## 1. 一句话目标

作者可以创建可比较的本地项目快照，在不覆盖未选择内容的前提下恢复所选 Markdown；可以查看目录、脚注、图片、引用和证据健康度，并把与该快照严格绑定的作品导出为经过真实渲染检查的 DOCX。

## 2. 解决的真实问题

1. History 记录一次已确认修改和 Safe Undo，但不能代表作者主动冻结的完整项目状态。
2. 当前“诊断导出”只导出脱敏运行信息，不能导出作品；PDF 代码只负责来源导入和文本提取，也不是作品导出器。
3. Graph 已有关系图、筛选、证据和 Issue→Changes，但时间线、实体表和论点—证据表还不是同一工作区中的正式视图。
4. SourceIndex 和引用格式化能定位来源、生成脚注，但没有项目级引用健康审计，也不能解释“缺来源、定位漂移、重复来源、单一证据”。
5. 图片插入和可恢复废纸篓已有安全合同，但导出前还不能统一说明缺失图片、alt/caption 和不可交付资源。

## 3. 当前源码与测试核对

以下是 2026-08-06 的 **focused baseline evidence**，只说明可复用基础，不是当前全量总数，也不代表 0.4.0 功能已经存在：

| 现有能力 | 当前证据 | 0.4.0 处理方式 |
|---|---|---|
| Change History v3 / Safe Undo | `verify-v0-change-history.js` 14/14 | 复用 revision、History、冲突和恢复事务；不得把单次操作历史包装成项目快照 |
| 作者验收 copy transaction | 当前完整专项已有 48/48 基线 | 只作为隔离验收工具；不得直接暴露成通用快照 UI 或宣称云/异盘备份 |
| 诊断预览与导出 | Service 13/13，内容严格排除正文与路径 | 保持诊断合同不变；作品导出建立独立 service、manifest、token 和写入协议 |
| SourceIndex / citation formatter | SourceIndex 10/10，Citation 10/10 | 作为引用健康度输入；Main 重新绑定来源、脚注和 locator，不信任 Renderer 统计 |
| Graph v2 / filters / evidence | Filter 17/17，Workbench 14/14 | 所有新视图复用同一 Graph v2 快照、筛选、纠错和证据；禁止第二套分析或索引 |
| Image Trash | Service 21/21 | 保留精确资产恢复/清理边界；不把“已保留素材”与废纸篓混为一谈 |
| PDF extraction | Timeout 3/3，当前只服务来源导入 | 不复用为作品输出；0.4.0 不同时开发 PDF 导出 |

## 4. 已批准产品决定

### 4.1 首个正式导出格式选择 DOCX

- 0.4.0 只实现 DOCX，不同时承诺 PDF。
- DOCX 更符合长文作者向编辑、审校和合作方交付可继续修改文稿的场景；PDF 留在后续候选池。
- “正式导出”表示格式、内容、资源、失败和真实渲染都有冻结验收合同，不表示 1.0 稳定版、出版平台分发或商业生产许可。
- V1 必须列出支持的 Markdown 子集。不能可靠表达的语法必须在预检中显示“降级/不支持”，不得静默丢失。

### 4.2 快照是本地恢复点，不是备份承诺

- 快照由 Main 从一个强制 watcher barrier 后的权威项目状态创建，绑定 project instance、mutation generation、文件 revision、内容摘要和资源清单。
- V1 至少冻结公开 Markdown 和正文实际引用的项目内图片，供比较和 exact-snapshot DOCX 导出使用；是否纳入其他附件由阶段 0 的容量/隐私合同决定。
- 快照不得包含 API Key、应用 profile、缓存、Graph 派生数据、指标、诊断日志或未列入 allowlist 的隐藏文件。
- 快照保存在项目私有、权限受限且有容量上限的存储中；同盘本地快照不能被宣传为异盘或云备份。
- 作者可以列出和显式移除 exact snapshot；容量不足不得自动删除旧快照。快照删除只影响私有恢复点，不得改变公开项目文件。

Snapshot 创建/发布必须在阶段 0 冻结独立事务合同，至少覆盖：

- 从可信项目根 fd 做 no-follow 逐级遍历，绑定每个来源祖先、文件身份、模式、大小和摘要；snapshot allowlist 与复制字节来自同一个初始权威扫描；
- 目标私有父目录、stage、manifest 和 receipt 的 owner、权限、身份、容量与摘要校验；任何 symlink、hard-link、父目录替换或同 inode 改写均 fail closed；
- 最终来源重检是原子 no-clobber 发布前最后一个动作；发布后再验证目标身份和 manifest digest；
- 事务终态严格区分 proven `UNCOMMITTED`、proven `COMMITTED` 和 `UNKNOWN`。只有 proven uncommitted 且 exact owned 的私有 stage 可以清理；committed/unknown 不得进入预提交清理；
- committed 后的 fsync、响应丢失和重试真相必须持久化，重试只能补齐证据/持久化/响应，不能重新复制或覆盖 snapshot。

Snapshot 删除也必须在阶段 0 冻结独立安全事务：Main 铸造绑定 exact snapshot identity 与 manifest digest 的短期删除 capability；先把目标移动到不可猜测的私有隔离区，再重检 inode、权限、大小、canonical parent 和内容/manifest digest。并发替换、同 inode 改写或任一身份漂移均 fail closed；只删除隔离区中已证明属于本事务的 exact identity，并持久化删除提交或恢复真相，不能以路径存在性推断成功。

### 4.3 恢复必须先比较，再选择，再确认

- 恢复前展示 Main 构建的文件级状态和正文 Diff：新增、修改、缺失、相同、当前冲突。
- V1 只恢复作者明确选择且存在于快照中的公开 Markdown；不得删除快照之后新增的文件，也不得修改未选择文件。图片进入 snapshot 和 DOCX 绑定，但 V1 不覆盖或恢复二进制图片。当前项目图片相对快照发生漂移只进入比较结果，不影响从快照内已验证字节完成 exact-snapshot DOCX；只有快照内图片缺失、损坏或与 manifest 不一致时才阻断导出。现有素材恢复路径只用于作者手动恢复当前项目素材，不承诺能重建任意快照图片。
- Markdown 恢复写入复用既有 revision、History、recovery marker、目录 fsync、authoritative reload 和 Safe Undo 边界。二进制资产若未来需要恢复，必须先冻结独立资产事务，不能借用只支持 Markdown 的 History。
- 当前项目、snapshot、revision、路径或资源身份漂移时 fail closed；取消、失败和冲突均为零正文写入。

### 4.4 导出绑定精确快照

- 导出预检、DOCX 编译和最终保存必须绑定同一个不可变 snapshot identity；项目变化后旧预检不能继续导出。
- Main 冻结统一 `deliveryAuthority`：`projectInstanceId + snapshotId + snapshotManifestDigest + creationMutationGeneration + fileRevisionSetDigest + graphIdentity + graphManifestDigest + sourceIndexRevision`；这里的每一项都是必需分量，不是二选一。Graph manifest 与 SourceIndex 必须明确绑定同一个 `snapshotId` 和 `fileRevisionSetDigest`；任一分量缺失或不一致时，健康报告只能标记 stale，不能铸造 DOCX export capability。
- Main 构造导出 manifest 和 DOCX 字节；Renderer 只提交 opaque ID、作者选择和确认，不提交正文、root 或输出路径。
- 原生保存对话框由 Main 打开；取消不写文件，现有目标不覆盖，临时产物失败后清理，提交后异常从磁盘真相协调。
- 导出完全离线，不调用模型，不上传作品，不把正文或绝对路径写入日志和 Nowledge Mem。
- Snapshot、预检和 DOCX 编译使用各自的 Main owner 与真实阶段；达到阶段 0 冻结的等待阈值后提供取消，并受有界 deadline 约束。取消只终止本次本地任务，不能复用 0.3.0 AI task 身份或伪装成 AI 请求。
- 作品导出不得复用诊断导出的 schema、preview token、IPC 名称或“诊断与隐私”界面；两者只共享稳定架构原则，不共享内容权限和用户入口。

### 4.5 Graph 多视图只做同一证据的不同投影

- 保留现有关系图，并在同一 Graph 工作区增加时间线、实体表、论点—证据表。
- 四种视图使用同一个 `writcraft.graph/v2` identity、筛选状态、Issue 状态、作者纠错和 evidence locator。
- 视图切换不得重建第二套 Graph、改变正文或把图谱关系误称为事实真相。
- 视图切换保持当前 scope、筛选、选中 evidence、键盘焦点、可访问名称和返回位置；不得重新调用模型或因切换视图重建 Graph。
- 任一行、节点、事件、论点或警告都必须能回到 Main 校验过的项目相对路径、revision 和 locator；stale 时禁止错误跳转。

### 4.6 引用健康度只报告可证明的问题

V1 只冻结以下类型：

- `missing_source`：正文存在明确待补来源标记，或结构化论点没有任何来源绑定；
- `stale_locator`：已绑定来源或正文 locator 的 revision/quote 不再匹配；
- `duplicate_source`：两个来源记录经规范化 URL 或内容摘要证明为同一来源；
- `single_evidence`：结构化论点当前只有一条可验证证据，界面必须称为“证据单一”，不能称为错误或虚假；
- `broken_footnote`：脚注引用和定义缺失、重复或无法唯一绑定。

每个健康项必须包含稳定 ID、严重度、可解释原因、当前 revision 和可点击 evidence。系统不自动裁定观点真伪，不在线搜索替代来源，不解析自由文本生成权威引用。任何正文修复都只能进入普通 Changes/Diff，由作者确认。

现有 citation formatter 位于 Renderer，Main 不得导入它。阶段 0 必须二选一并冻结唯一规则：把可复用的纯规范化/格式化逻辑迁移到 `src/shared/` 并加入 Node/Renderer 等价测试，或建立一个 Main-only 权威实现并让 Renderer 只消费结果；禁止复制出两套 citation 身份和格式规则。

### 4.7 媒体交付保持最小范围

- 0.4.0 必须在导出预检中报告缺失图片、越界图片、不可解码图片和缺少 alt/caption 的资源。
- alt/caption 独立编辑和已保留素材清理继续留在 0.4.0 候选池；只有阶段 0 证明它们阻断 DOCX 最短交付旅程，并经所有者明确纳入，才进入实现范围。
- 不扩大 Image Trash，不复用生成 prompt 作为 alt/caption，也不自动删除未引用素材。

## 5. 分阶段路线

| 阶段 | 交付 | 退出条件 |
|---|---|---|
| 0 | ✅ 合同冻结与基线盘点（仅文档，已完成） | [`EVIDENCE-DELIVERY-V1-CONTRACT.md`](EVIDENCE-DELIVERY-V1-CONTRACT.md) 已冻结 DOCX 子集、snapshot copy/publish 三态事务、snapshot 删除事务、allowlist/容量、恢复不删除原则、delivery authority、导出 manifest、健康类型、真实渲染基准、失败矩阵和媒体范围；活动文档派工权已清理。独立复审 P0=0/P1=0、P2=4，详见 [`0.4.0-STAGE-0-INDEPENDENT-REVIEW.md`](0.4.0-STAGE-0-INDEPENDENT-REVIEW.md)；阶段 0 未改产品版本或实现代码 |
| A | ▶️ Main 项目快照、比较与恢复权威（当前；A1a 已签收，A1b P1=0 待复审） | 完成独立 snapshot service/handler、窄 IPC、私有存储、容量/权限/损坏处理、列表/显式删除、比较和 Markdown 选择性恢复；取消/失败/冲突/项目切换零写入，提交后 History/recovery/Safe Undo 真相一致；二进制图片只冻结/比较，不借 Markdown History 恢复。A1b 两个 P1（fresh R identity、formal mixed rollback 出口）已关闭，当前等待一次完整独立复审；复审通过后再按执行协议进入 A1c、A2 与 A3；历史 A-R1.1–A-R1.4 只保留为组件证据 |
| B | ✅ 导出预检与引用健康度（独立纵切已完成；等待 A→B 重签） | Main 从 exact snapshot 生成目录、标题层级、脚注、引用、图片、资源和健康 manifest；五类健康项有稳定 evidence，stale/partial/budget 状态明确，完全离线且不写正文。Stage A 签收后必须以 App 创建的真实 snapshot 重跑连续旅程；direct seed 只保留为纯层 fixture |
| C | DOCX 编译、验证与安全保存 | 单一 DOCX exporter 覆盖冻结 Markdown 子集；私有临时构建、OOXML 结构校验、Main 保存对话框、no-clobber 和 committed reconciliation 完成；真实渲染检查通过，不把文件存在当作成功 |
| D | Graph 多视图与连续交付体验 | 关系图、时间线、实体表、论点—证据表共享一个 Graph v2 快照和筛选；从健康/Graph evidence 可回正文或发起可审阅 Diff；快照→预检→修复→导出在同一项目上下文中连续可理解 |
| E | 真实作者验收与发布候选 | 在所有者选定项目的隔离副本完成快照、比较、选择性恢复、冲突、Safe Undo、预检、健康项、四 Graph 视图、DOCX 导出和真实打开检查；完整测试、真实 Electron、Computer Use、独立复审 P0=0/P1=0，P2 明确记录后才可成为 0.4.0 候选 |

## 6. 关键失败矩阵

| 边界 | 必须结果 |
|---|---|
| watcher barrier、扫描、预算或权限失败 | 不发布 snapshot，不继续预检或导出 |
| snapshot 创建取消/失败 | 不出现半个可用快照；私有临时状态安全清理或进入明确恢复状态 |
| snapshot 删除竞争、身份漂移或响应丢失 | 并发替换 fail closed；只删除隔离区中的 exact owned identity；从持久化事务和磁盘真相返回未提交、已提交或未知状态 |
| 比较后项目或 snapshot 漂移 | 旧恢复确认失效，必须重新比较 |
| 恢复取消、冲突或预提交失败 | Markdown、资源、History 均零写入 |
| 恢复提交后响应/刷新失败 | 从文件、History 和 recovery marker 协调 committed truth，不重放恢复 |
| 预检发现 hard blocker | 不铸造可导出 capability；界面给出证据和可执行修复动作 |
| 当前项目图片相对 snapshot 漂移 | 显示比较差异；只要 snapshot 内图片字节与 manifest 完整，仍从 snapshot 导出，不读取漂移后的当前文件 |
| snapshot 内图片缺失、损坏或 manifest 不匹配 | hard blocker；不得回退读取当前项目图片或宣称现有素材恢复一定可还原 snapshot |
| 只有 warning | 作者可明确选择继续，DOCX manifest 保留 warning 摘要；不能伪装成“全部通过” |
| DOCX 编译、校验或临时 fsync 失败 | 目标路径不存在或保持原样，不留下可误认的半成品 |
| 原生保存取消或目标已存在 | 零目标写入，不自动覆盖 |
| 最终提交已发生但响应丢失 | 独立反查目标身份和摘要，返回 committed 或 committed-risk；不得按未提交清理 |
| Graph/健康 evidence stale | 可见标记 stale，禁止错误跳转、AI 调用或可写 capability |
| 项目切换/窗口销毁/迟到结果 | 旧项目结果不得进入新项目 UI、快照、导出或文件系统 |

## 7. 验收标准

1. 作者能用一句话解释当前交付基于哪个快照、有哪些阻断/警告、最终导出了什么。
2. 创建快照不改变项目公开文件；选择性恢复只改变作者选择的 Markdown，并可通过 History Safe Undo。
3. 快照之后新增且未选择的文件不会被恢复流程删除或覆盖。
4. 导出前能检查目录、标题层级、脚注、来源、图片和缺失资源；每个问题能回到证据。
5. DOCX 在阶段 0 冻结的真实桌面应用及 exact 版本中打开，标题层级、正文、列表、脚注和至少一张本地图片可读；测试同时验证 OOXML 结构和真实渲染，不只验证文件存在。应用缺失、自动修复提示或兼容模式都不能算通过。
6. 关系图、时间线、实体表和论点—证据表显示同一 Graph identity，筛选和 evidence 跳转一致。
7. 五类引用健康项均有确定性正反例；系统不自动判断观点真伪，不制造来源。
8. 项目切换、revision 漂移、外部修改、取消、部分提交、目标竞争和重复请求全部 fail closed 或发布真实 committed 状态。

## 8. 明确不做

- 不开发 PDF 导出、EPUB、网页发布或出版平台分发。
- 不把本地 snapshot 宣传为云备份、Time Machine 或灾难恢复。
- 不做自动定时快照、无限版本、跨项目快照或多项目记忆。
- 不恢复快照后自动删除新文件，不提供“整个项目无确认回滚”。
- 不建立第二套 Graph、来源索引、文件扫描器或交付驾驶舱。
- 不自动裁定观点真伪，不抓取外部 Research，不补写虚构引用。
- 不扩大 AI 写入权限；所有 AI 修复继续经过明确 Diff 和作者确认。
- 不在 0.4.0 自动加入 App 签名、公证、`latest` 移动或稳定版承诺。

## 9. 验证与文档门禁

- 每阶段先记录源码/测试当前事实，再更新本路线图、`docs/ROADMAP.md`、`v0/DEVELOPMENT-STATUS.md`、受影响合同、README 和 Nowledge Mem。
- 新增专项必须覆盖 Main service、handler/IPC/preload、Renderer state/UI、故障注入、项目切换和真实 Electron；测试不能从 Renderer fixture 自我证明 Main 权威。
- DOCX 需使用最大合法 Unicode/脚注/图片 fixture、损坏资源、超限项目和目标竞争反例，并在真实 macOS 应用中完成打开与视觉核对。
- 阶段 0 必须记录真实渲染主应用和 exact 版本（候选为 Microsoft Word、Pages 或 LibreOffice 中所有者实际可用的一种）、OOXML package/schema 校验方式、固定 Unicode/脚注/列表/图片/分页 fixture、可自动比较的渲染产物及人工视觉清单；主应用缺失时阶段 0 不能退出，不能临时换应用取得绿灯。
- Graph 多视图必须保留现有 300 文件/500 节点性能与可访问性门禁；不能用静态表测试代替关系图回归。
- 真实作者验收只使用所有者指定项目的生产隔离副本，源目录前后摘要不变；正文、来源、路径、Key 和截图不得进入 Git、日志或 Nowledge Mem。
- 保留首个失败证据；代码通过、自动化通过、真实 Electron 通过、作者签收和外部发布授权必须分别记录。
- 只有阶段 0–E 完成、P0=0/P1=0、P2 明确、文档与 Nowledge Mem 同步后，才能报告 0.4.0 候选完成。npm、Tag、GitHub Release、App/ZIP 和 `latest` 仍需另行授权。
- 当前 Stage A 未签收前禁止 Stage C/D/E 实现；Stage B 已签收纯层不得扩写，只能在 Stage A 后补真实 A→B 连续证据。
- fixture seed、fake/injected adapter、no-op helper 和 focused 绿灯不能签收跨层或跨阶段旅程；下游必须消费上游生产入口创建的真实产物。
- 从 A0 起，全部新增或改名验证脚本必须在同一 change set 进入显式清册和当前 component/stage 顶级 npm gate；静态 orphan check 未绿时不得继续实现。component 绿灯不等于 stage 完成；`candidate` 名称只在 C/D/E 完成后的封版候选使用。

## 10. 已批准决定与启动门禁

所有者已于 2026-08-06 确认以下四项，并将本文件批准为 `WRC-0.4.0-R1`；随后已另行提交 §11 的完整目标模式指令。阶段 0 已按顺序完成并签收，当前只授权继续阶段 A；仍不授权跳过 A–E 或执行外部发布：

1. 首个正式导出格式为 DOCX，PDF 延后；
2. Snapshot v1 不删除快照后新增文件；冻结公开 Markdown 和被正文引用的项目内图片，但只恢复作者选择的 Markdown；图片只用于比较和从快照内已验证字节导出，当前项目图片漂移不阻断 exact-snapshot DOCX，现有素材路径只辅助作者恢复当前项目素材；
3. Graph 固定为关系图、时间线、实体表、论点—证据表四个共享证据视图；
4. alt/caption 编辑与已保留素材清理默认不进入必做范围，除非阶段 0 证明它们阻断最短 DOCX 交付旅程并再次获批。

## 11. 已生效的目标模式文本

以下文本已由所有者于 2026-08-06 另行提交并生效；执行状态以 §5 和 `v0/DEVELOPMENT-STATUS.md` 为准：

> 自主完成 WritCraft 0.4.0「证据与交付闭环」开发，并推进到真实作者可验收状态。
>
> 严格依据生效路线图 `docs/ROADMAP-0.4.0.md`（`WRC-0.4.0-R1`）执行，按阶段 0 → A → B → C → D → E 推进。当前源码、测试和真实运行结果优先于历史文档；发现活动文档落后时，先同步文档再继续开发。阶段 0 只冻结合同和基线，不写实现代码；阶段 0 独立复审 P0/P1 清零后才进入阶段 A。
>
> 阶段 0 冻结 Snapshot、DOCX、delivery authority、引用健康度、Graph 多视图、真实渲染和失败矩阵合同，并清除旧版本文档的派工权；阶段 A 建立 Main 项目快照、比较、Markdown 选择性恢复和安全删除权威；阶段 B 建立 exact-snapshot 导出预检与五类可证明的引用健康项；阶段 C 完成单一 DOCX 编译、OOXML 校验、原生 no-clobber 保存和 committed reconciliation；阶段 D 在同一 Graph v2 上完成关系图、时间线、实体表、论点—证据表及连续交付体验；阶段 E 使用真实作者隔离副本完成必要验收、真实 DOCX 打开检查、完整回归和独立复审。
>
> 必须保持：Snapshot 是本地恢复点而非备份，不自动删除旧快照或快照后新增文件，只恢复作者明确选择的 Markdown；图片只进入比较和从快照字节导出，不借用 Markdown History 恢复。DOCX 完全离线并绑定同一不可变 snapshot，不复用诊断导出的 schema、token、IPC 或界面。Graph 四视图共享同一个 `writcraft.graph/v2` identity、筛选、纠错和 evidence。引用健康度只允许 `missing_source`、`stale_locator`、`duplicate_source`、`single_evidence`、`broken_footnote` 五类可证明问题，不自动裁定观点真伪或补写来源。Main 保持文件、revision、capability、保存和事务权威；Renderer 不提交绝对路径、正文或输出路径。所有 AI 正文修改继续经过明确 Diff 和作者确认；保留 History、冲突检测、项目隔离和 Safe Undo。
>
> 不得重复开发既有 History、Diagnostic Export、SourceIndex、Citation、Graph v2、Image Trash 或 0.3.0 透明任务基础；不得以复用诊断导出器、扩大 AI 写入权限、解析自由文本、第二套 Graph/索引/扫描器或降低安全校验解决失败。不开发 PDF/EPUB/网页发布、云备份、自动定时快照、无限版本、跨项目快照、多项目记忆、外部 Research 引擎、alt/caption 独立编辑或已保留素材清理，除非路线图另行明确批准。
>
> 每个阶段必须先检查源码、测试和当前运行证据；同步更新 `docs/ROADMAP-0.4.0.md`、`docs/ROADMAP.md`、`v0/DEVELOPMENT-STATUS.md`、受影响合同、README 和 Nowledge Mem；执行相关专项、`npm test`、`npm run verify`、真实 Electron/Computer Use 验证和独立复审；保留首个失败证据，并明确区分代码通过、自动化通过、真实 Electron 通过、真实作者验收通过和外部发布授权。
>
> 只有阶段 0–E 全部完成，取消/失败/冲突/项目切换零非预期写入，Snapshot 与 DOCX 事务真相可协调，真实 DOCX 渲染通过，受影响测试与真实 Electron 通过，独立复审达到 P0=0、P1=0、P2 已明确记录，关键文档和 Nowledge Mem 同步后，才可报告 0.4.0 候选完成。未经单独授权，不发布 npm、不移动 dist-tag、不创建 GitHub Release/Tag、不推送发布提交、不分发 App/ZIP、不修改公开仓库状态。
