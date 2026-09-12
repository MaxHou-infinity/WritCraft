# WritCraft 证据与交付 V1 合同

> 合同编号：`WRC-EVIDENCE-DELIVERY-V1`
> 适用版本：`writ-craft@0.4.0`
> 冻结日期：2026-08-06
> 状态：**阶段 0 已冻结并经独立复审签收（P0=0、P1=0、P2=4）；阶段 A 进行中。A-R1.1 首红 P0=0/P1=7/P2=1，A-R1.2 为 P0=0/P1=4/P2=1，A-R1.3 为 P0=0/P1=2/P2=0，A-R1.4 已由同一独立复审员以 P0=0/P1=0/P2=0 签收；native/storage 实现门禁已解锁，但阶段 A、App 与真实作者验收均未完成**
>
> 进度指针（2026-09-12）：上述 A-R1.x 数字是组件层历史证据。**当前 checkpoint 进度以 [`../v0/DEVELOPMENT-STATUS.md`](../v0/DEVELOPMENT-STATUS.md) 顶部控制块为唯一权威** —— A0、A1a、A1b（`1f43b7f`）、A2a（`b16ffc7`）已代码级签收，下一 checkpoint 为 A1c；本合同的验收语义未变，仍是 0.4.0 的当前验收依据。
> 上位合同：`docs/ROADMAP-0.4.0.md`（`WRC-0.4.0-R1`）

本合同冻结 0.4.0 的 Snapshot、选择性恢复、交付预检、引用健康度、DOCX、Graph 多视图和真实渲染边界。它不授权发布，也不把现有 History、Diagnostic Export、SourceIndex、Citation、Graph v2、Image Trash 或 0.3.0 AI task 包装成新能力。

## 1. 不变量与权威

1. Main 独占项目根、绝对路径、文件身份、revision、snapshot 字节、capability、原生保存对话框和事务真相；Renderer 只能提交当前 `projectInstanceId`、Main 签发的 opaque ID、作者选择和确认。
2. Renderer 不提交绝对路径、输出路径、正文、snapshot manifest、Graph manifest 或 SourceIndex 内容。Preload 只暴露字段受限的窄 IPC。
3. Snapshot 是同盘、本地、有限容量的恢复点，不是备份、同步或灾难恢复。创建、比较、删除和导出不得调用模型或网络。
4. Snapshot 创建不改公开项目文件；恢复只写作者明确选择的公开 Markdown。图片只冻结、比较并从 snapshot 字节导出，不通过 Markdown History 恢复。
5. DOCX 预检、编译、校验和保存绑定同一个不可变 snapshot。任何 fallback 都不得读取已漂移的当前项目字节补齐 snapshot。
6. Graph 四视图只投影同一个 `writcraft.graph/v2` 结果；引用健康度只报告五类可证明问题。任何 AI 修复仍进入普通 Changes/Diff，由作者确认。
7. 取消、失败、冲突、窗口销毁、项目切换和迟到结果不能把旧项目状态、文件或 capability 带入新项目。

## 2. 既有基础的复用边界

| 既有能力 | 允许复用 | 明确禁止 |
|---|---|---|
| Project watcher/hash helper | Main-owned barrier、项目根绑定、ancestor/leaf identity、摘要 | 第二套项目扫描器；用稳定时间窗代替 barrier |
| Change History v3 / recovery | Markdown revision、History、recovery marker、目录 fsync、authoritative reload、Safe Undo | 把 History 记录称为项目快照；恢复图片或任意二进制 |
| Author acceptance copy transaction | 原生 no-follow/no-clobber、三态协调的工程模式 | 直接暴露现有 copy UI/manifest 作为 Snapshot |
| SourceIndex | 来源记录和 revision 输入 | 第二套来源索引；Renderer 统计成为健康权威 |
| Citation formatter | 迁移后的共享纯规范化/脚注规则 | Main 导入 Renderer；复制两套 citation 身份规则 |
| Graph v2 | identity、evidence、filters、corrections、Issue state | 第二套 Graph、第二次模型调用、切视图重建 Graph |
| Diagnostic Export | 仅参考稳定架构原则 | 复用 schema、token、IPC、内容 allowlist、界面或输出权限 |
| Image Trash | 现有作者手动素材恢复/删除能力保持不变 | 自动清理素材；承诺从 Trash 重建 snapshot 图片 |
| 0.3.0 AI task | 只保持兼容回归 | 用 AI task identity/copy 表示本地 snapshot 或 export 任务 |

Citation 的唯一实现决定为：把 citation identity、URL 规范化、footnote key 和格式化所需的纯逻辑迁移到 `v0/src/shared/citation-identity.js`；Main 与 Renderer 共同调用同一模块，并以 Node/Renderer 等价 fixture 证明结果一致。任何依赖 DOM、文件系统或网络的逻辑不得进入 shared。

## 3. Snapshot V1 公开合同

### 3.1 Schema 与身份

- manifest schema：`writcraft.snapshot/v1`。
- transaction schema：`writcraft.snapshot-transaction/v1`。
- delete transaction schema：`writcraft.snapshot-delete-transaction/v1`。
- `snapshotId` 为 Main 生成的不可猜测 opaque ID；Renderer 不接收私有存储路径。
- manifest 至少绑定：`projectInstanceId`、`snapshotId`、`createdAt`、`creationMutationGeneration`、可信项目根 identity、排序后的文件项、`fileRevisionSetDigest`、`snapshotManifestDigest`、预算摘要和 producer 版本。
- 每个文件项至少绑定项目相对 POSIX path、kind、mode、byteLength、SHA-256、公开 revision、来源祖先 identity chain 和 snapshot 内部对象 identity；不记录绝对路径。
- snapshot manifest 和 receipt 是私有权威记录，不作为 Renderer 可编辑对象。Renderer 只得到受限摘要、opaque file ID、相对路径、kind、大小、状态和时间。

exact-key 集合冻结为：

- snapshot manifest：`schema`、`projectInstanceId`、`snapshotId`、`createdAt`、`creationMutationGeneration`、`rootIdentityDigest`、`files`、`fileRevisionSetDigest`、`budgets`、`producerVersion`、`snapshotManifestDigest`；
- snapshot file item：`fileId`、`path`、`kind`、`mode`、`byteLength`、`sha256`、`revision`、`ancestorIdentityDigest`、`sourceObjectIdentityDigest`、`bundleObjectDigest`、`references`；前者只表示源 inode/metadata identity，后者只表示 bundle header+content；
- delivery authority：`schema`、`projectInstanceId`、`snapshotId`、`snapshotManifestDigest`、`creationMutationGeneration`、`fileRevisionSetDigest`、`graphIdentity`、`graphManifestDigest`、`sourceIndexRevision`、`authorityDigest`；
- citation health item：`schema`、`healthId`、`type`、`severity`、`reasonCode`、`snapshotId`、`subjectId`、`revisionBinding`、`evidence`、`nextAction`；
- delivery manifest：`schema`、`authority`、`selectedFiles`、`outline`、`footnotes`、`sources`、`images`、`resources`、`syntaxCoverage`、`health`、`blockers`、`warnings`、`manifestDigest`。

所有嵌套、事务、capability 与 public projection 的 exact keys 均在 3.1.1–3.1.5 冻结；生产解析器拒绝任何额外键。上述私有 manifest 可包含安全事务所需的完整身份摘要；public projection 不能返回 root identity、ancestor identity、source object identity、输出路径或任何 capability 原文。“正文”特指段落/行级作者内容，唯一例外是 3.1.3 的 Main 生成、有界 snapshot Diff `line.text`；Main 生成的有界标题 `outline.text` 与显示标签 `subjectLabel` 是 metadata，不是正文例外。Renderer 始终不得提交正文。

所有 authority/manifest/receipt 使用 exact-key 普通对象、UTF-8 和 RFC 8785 风格的确定性 JSON：对象键按 Unicode code point 升序，数组保持合同顺序，禁止浮点、`undefined`、非有限数、C0 control 和 unpaired surrogate；U+007F 不在该禁止集，parser 不得额外拒绝；摘要为 `sha256:` 加 64 位小写十六进制。项目相对路径是来源文件系统返回并由 Main 校验的 opaque NFC-agnostic identity，不做 NFKC、大小写折叠或 trim；显示文本的规范化不得改变 path/source identity。parser 必须先证明对象是无 getter/accessor 的 plain data record，再读取包括 `schema` 在内的任何字段。

阶段 A 必须把本节已冻结的 schema 写成代码常量和 hostile fixture；不能自行增删字段、接受额外字段、局部 schema 或解析后再修补的值。任何 schema 变更必须先回到本合同复审。

#### 3.1.1 嵌套 exact-key 与类型

- `budgets`：`limits`、`observed`。`limits` exact keys 为 `maxMarkdownFiles`、`maxImageFiles`、`maxTotalItems`、`maxMarkdownFileBytes`、`maxMarkdownTotalBytes`、`maxImageFileBytes`、`maxSnapshotBytes`、`maxManifestBytes`、`maxControlRecordBytes`、`maxPrivateMetadataBytes`；`observed` exact keys 为 `markdownFiles`、`imageFiles`、`totalItems`、`markdownBytes`、`imageBytes`、`snapshotBytes`、`manifestBytes`、`privateMetadataBytes`。全部为非负安全整数。
- file `references` item：`fromFileId`、`tokenOrdinal`、`locatorDigest`；只有 `kind=image` 的 file item 可携带，最多 2000 项/图片，且每个 `fromFileId` 必须指向同一 manifest 内的 `kind=markdown` file item；Markdown item 的 `references` 必须是空数组。
- snapshot image-token pass envelope：`schema`（`writcraft.snapshot-image-token-pass/v1`）、`transactionId`、`parserId`、`candidates`；`parserId` exact 值冻结为 `marked@18.0.6+sha256:62ad5de5bea6d79b4c47e5c0b5cbe4be61e25ee8994595c2cc0969b2a144cc5d`。candidate exact keys 为 `candidateId`、`captureDigest`、`fileId`、`revision`、`tokens`；token exact keys 为 `tokenOrdinal`、`rawTokenSha256`、`hrefUtf8Base64`、`locatorDigest`。candidate 必须与 helper 本次 sealed capture 一一对应、按 native 签发顺序排列且最多 300 项；`captureDigest` 是 3.1.5 的完整 Markdown sealed-capture payload 摘要，同一 pass 的全部 candidate 必须逐字相同。`tokenOrdinal` 是固定选项下 `marked.walkTokens` 深度优先访问**全部** token 时从 0 开始的全局序号，不是 image-only 序号，tokens 按该值严格递增。`rawTokenSha256` 绑定 token 的 exact UTF-8 `raw`，`hrefUtf8Base64` 绑定 marked 已解析的 exact `href` UTF-8 bytes；单个 raw href 继承 3.1.5 的 4096-byte URL 上限，超过即为 token-pass budget failure，不能截断、只留 digest 或静默丢弃。helper 不信任 Main 的路径判断，必须按下一段独立解析并绑定来源。全部 sealed Markdown exact bytes 仍须同时满足 300 文件/单文件 4 MiB/合计 64 MiB；整个 pass 最多 10,000 个 image token、确定性 JSON 最多 4 MiB，并计入 8 MiB 私有事务元数据预算。shared adapter 必须在 tokenization 前累计 sealed input bytes，并在组装过程中增量计算输出 envelope 预算；任一超限都在返回 authority 前 fail closed。

图片 `href` 由 shared tokenizer 原样绑定，native 再把它分类为 eligible project image 或 excluded/unavailable reference；token pass 必须保留全部 marked image token，不能因为 href 类别而丢弃 token 或把 Stage B blocker 提前升级为 snapshot 创建失败。eligible path 是相对于其 `fromFileId` Markdown 所在目录的 source-relative URL path：fragment 不参与文件 path；helper 对 URL path 只做一次严格 UTF-8 percent decode，再从已持有的 Markdown parent fd 逐段 descriptor-relative 解析 `.`/`..`。允许既有 `chapters/*.md` 引用 `../assets/generated/*`，但 canonical resolution 必须始终由可信 root fd 约束且最终仍在项目根内；每个外部 component 都 no-follow。空值、scheme/network path、query、反斜线、NUL、绝对路径、非法/非 UTF-8 percent encoding、越出 root、隐藏/排除 component、不受支持扩展、missing leaf 或 symlink 只被分类为 excluded/unavailable，不读取、不复制、不写入 manifest 图片项；其 exact token identity/href 仍由 immutable Markdown 保留，阶段 B 从同一 parser authority 重建对应 blocker。只有 token-pass schema/identity/digest/预算损坏、eligible 来源在复制期间漂移或权威 scan 失败才使 snapshot 创建 fail closed。Main/Renderer 不做路径 canonicalization，也不能把 token href 改写后重试。
- `revisionBinding`：`fileRevisionSetDigest`、`subjectRevision`、`locatorDigest`、`quoteSha256`；不可适用字段必须为 `null`，不能省略。
- health `evidence` item：`evidenceId`、`fileId`、`revision`、`blockId`、`start`、`end`、`quoteSha256`、`contentSha256`；最多 100 项，offset 为安全整数且 `0 <= start < end`。
- delivery `selectedFiles` item：`fileId`、`revision`、`sha256`、`order`、`pageBreakBefore`；`order` 从 0 连续递增。
- `outline` item：`outlineId`、`fileId`、`level`、`text`、`ordinal`；最多 5000 项，level 为 1–6。
- `footnotes` item：`footnoteId`、`key`、`definitionFileId`、`definitionLocatorDigest`、`referenceLocatorDigests`、`sourceId`；`sourceId` 可为 `null`，引用数组 1–100 项。
- `sources` item：`sourceId`、`sourceIndexRevision`、`displayTitle`、`displayUrl`、`duplicateIdentityUrl`、`contentSha256`、`evidenceIds`；显示字段有界，身份字段不可由显示字段反推。
- `images` item：`imageId`、`fileId`、`sha256`、`byteLength`、`mimeType`、`pixelWidth`、`pixelHeight`、`alt`、`caption`、`referenceLocatorDigests`。
- `resources` item：`resourceId`、`kind`、`status`、`reasonCode`、`fileId`、`locatorDigest`；`fileId` 可为 `null`。
- `syntaxCoverage`：`parserId`、`tokenCount`、`supportedCounts`、`warningCounts`、`unsupportedCounts`；三个 count map 只允许 7.1 枚举的 token/reason key 与非负安全整数。
- `blockers`/`warnings` item：`issueId`、`reasonCode`、`subjectId`、`evidenceIds`；分别最多 1000 项。所有数组按合同稳定顺序输出，字符串应用逐字段 byte/code-point 上限，C0 与 unpaired surrogate 一律拒绝。

#### 3.1.2 事务、comparison 与 capability exact keys

- snapshot transaction：`schema`、`transactionId`、`projectInstanceId`、`snapshotId`、`ownerGeneration`、`state`、`stageIdentityDigest`、`snapshotManifestDigest`、`createdAt`、`updatedAt`、`receiptDigest`、`lastErrorCode`；state 只允许 `PREPARING`、`UNCOMMITTED`、`COMMITTED`、`UNKNOWN`。
- snapshot receipt：`schema`（`writcraft.snapshot-receipt/v1`）、`transactionId`、`snapshotId`、`publishedIdentityDigest`、`snapshotManifestDigest`、`directoryFsyncComplete`、`committedAt`、`receiptDigest`。
- snapshot recovery marker：`schema`（`writcraft.snapshot-recovery/v1`）、`transactionId`、`snapshotId`、`expectedManifestDigest`、`expectedPublishedIdentityDigest`、`state`、`updatedAt`、`markerDigest`。
- delete transaction：`schema`、`transactionId`、`projectInstanceId`、`snapshotId`、`ownerGeneration`、`state`、`sourceIdentityDigest`、`quarantineIdentityDigest`、`snapshotManifestDigest`、`createdAt`、`updatedAt`、`receiptDigest`、`lastErrorCode`；state 同样只允许三态加 `PREPARING`。
- delete receipt：`schema`（`writcraft.snapshot-delete-receipt/v1`）、`transactionId`、`snapshotId`、`deletedIdentityDigest`、`snapshotManifestDigest`、`directoryFsyncComplete`、`committedAt`、`receiptDigest`。delete recovery：`schema`（`writcraft.snapshot-delete-recovery/v1`）、`transactionId`、`snapshotId`、`expectedManifestDigest`、`expectedDeletedIdentityDigest`、`state`、`updatedAt`、`markerDigest`。
- comparison：`schema`、`projectInstanceId`、`snapshotId`、`snapshotManifestDigest`、`currentMutationGeneration`、`currentFileRevisionSetDigest`、`items`、`createdAt`、`comparisonDigest`。item exact keys：`fileId`、`kind`、`status`、`snapshotRevision`、`currentRevision`、`snapshotSha256`、`currentSha256`、`byteDelta`、`diffId`；不可适用值必须为 `null`。
- snapshot restore result：`schema`（`writcraft.snapshot-restore-result/v1`）、`projectInstanceId`、`snapshotId`、`restoreCapabilityId`、`task`、`history`。`task` 必须是 3.1.3 的 terminal local-task；`history` exact keys 为 `operationId`、`outcome`、`status`、`affectedPaths`、`historyEntryId`、`recoveryRequired`、`responseRecovered`、`committedWarning`，不可适用字符串为 `null`，布尔值不得省略。`affectedPaths` 只由 Main 从 sealed selection 恢复为公开相对 Markdown path；Renderer 不提交 path。该 envelope 是 restore commit 的唯一直接返回值，Renderer 用它进入既有 Changes/History authoritative reconciliation；create/delete commit 直接返回 terminal local-task 后重新 list，不发明自由结构 `{ok,message}`。
- DOCX artifact：`schema`（`writcraft.docx-artifact/v1`）、`artifactId`、`projectInstanceId`、`snapshotId`、`authorityDigest`、`deliveryManifestDigest`、`byteLength`、`sha256`、`packageReportDigest`、`createdAt`、`expiresAt`、`artifactDigest`。
- DOCX save target binding（仅 private profile recovery store，`0700/0600`，永不进入 Renderer/日志）：`schema`（`writcraft.docx-save-target-binding/v1`）、`bindingId`、`absoluteTargetPath`、`parentChainDigest`、`finalBasename`、`stageBasename`、`volumeIdentityDigest`、`createdAt`、`bindingDigest`；path 最多 4096 UTF-8 bytes，basename 最多 255 bytes，禁止 NUL，bindingDigest 排除自身后按 3.1.4 计算。
- DOCX save transaction：`schema`（`writcraft.docx-save-transaction/v1`）、`transactionId`、`artifactId`、`ownerGeneration`、`state`、`artifactDigest`、`targetBindingDigest`、`stageIdentityDigest`、`expectedPublishedIdentityDigest`、`publishedIdentityDigest`、`createdAt`、`updatedAt`、`receiptDigest`、`lastErrorCode`；不可适用 digest 为 `null`。save receipt `writcraft.docx-save-receipt/v1` exact keys：`schema`、`transactionId`、`artifactId`、`targetBindingDigest`、`publishedIdentityDigest`、`artifactDigest`、`directoryFsyncComplete`、`committedAt`、`receiptDigest`。save recovery `writcraft.docx-save-recovery/v1` exact keys：`schema`、`transactionId`、`artifactId`、`targetBindingDigest`、`expectedArtifactDigest`、`stageIdentityDigest`、`expectedPublishedIdentityDigest`、`state`、`updatedAt`、`markerDigest`。
- delivery Graph binding：`schema`（`writcraft.delivery-graph-binding/v1`）、`snapshotId`、`fileRevisionSetDigest`、`graphIdentity`、`graphSchema`、`graphInputDigest`、`correctionsDigest`、`issueStateDigest`、`evidenceSetDigest`、`sourceBindings`；其完整对象摘要即 `graphManifestDigest`。source binding item exact keys 为 `schema`（`writcraft.graph-source-binding/v1`）、`bindingId`、`graphNodeId`、`sourceId`、`evidenceId`、`bindingDigest`，按 `graphNodeId + sourceId + evidenceId` 排序。`bindingId` payload schema 为 `writcraft.graph-source-binding-id/v1`，exact keys 为 `schema`、`graphIdentity`、`graphNodeId`、`sourceId`、`evidenceId`，`bindingId` 就是该 payload 的 3.1.4 完整 `sha256:` digest；`bindingDigest` 排除自身后对完整 item 使用 3.1.4 digest。
- delivery SourceIndex binding：`schema`（`writcraft.delivery-source-index-binding/v1`）、`snapshotId`、`fileRevisionSetDigest`、`inputDigest`、`itemDigests`、`partial`；其完整对象摘要即 `sourceIndexRevision`。item digest record exact keys 为 `sourceId`、`itemDigest`；`itemDigest` 的 payload schema 为 `writcraft.delivery-source-item/v1`，exact keys 为 `schema`、`sourceId`、`fileId`、`revision`、`contentSha256`、`displayUrl`、`locatorDigest`。最多 300 项并按 source ID byte order 排序。
- DOCX package report：`schema`（`writcraft.docx-package-report/v1`）、`artifactId`、`entryCount`、`compressedBytes`、`uncompressedBytes`、`entryDigests`、`relationshipDigest`、`contentTypesDigest`、`xmlAllowlistDigest`、`validationStatus`、`reportDigest`。entry digest item：`name`、`compressedBytes`、`uncompressedBytes`、`sha256`、`mimeType`；按 ZIP entry name byte order 排序，status 只允许 `valid|invalid`。
- citation health report：`schema`（`writcraft.citation-health-report/v1`）、`snapshotId`、`fileRevisionSetDigest`、`graphManifestDigest`、`sourceIndexRevision`、`status`、`items`、`reportDigest`；status 只允许 `complete`、`partial`、`stale`。
- capability 私有 record：`schema`（`writcraft.local-capability/v1`）、`capabilityId`、`kind`、`projectInstanceId`、`ownerGeneration`、`subjectId`、`authorityDigest`、`selectionDigest`、`issuedAt`、`expiresAt`、`singleUse`、`consumedAt`；Renderer 只持有随机 opaque `capabilityId`，不能看 record。
- capability kind 只允许 `SNAPSHOT_COMPARE`、`SNAPSHOT_RESTORE`、`SNAPSHOT_DELETE`、`DELIVERY_EXPORT`、`DOCX_ARTIFACT_SAVE`。`SNAPSHOT_COMPARE` 只读、`singleUse=false`，只可分页读 Diff/准备恢复；其余均 `singleUse=true`，第一次 commit 尝试前原子写入 `consumedAt`，迟到/重复请求拒绝。
- `selectionDigest` 按 kind 使用 3.1.4 digest：compare payload `writcraft.snapshot-compare-selection/v1` exact keys 为 `schema`、`projectInstanceId`、`snapshotId`、`snapshotManifestDigest`、`currentMutationGeneration`、`currentFileRevisionSetDigest`、`comparisonDigest`；restore payload `writcraft.snapshot-restore-selection/v1` 为 `schema`、`compareCapabilityId`、`comparisonDigest`、`selectedIds`、`currentMutationGeneration`、`currentFileRevisionSetDigest`；delete payload `writcraft.snapshot-delete-selection/v1` 为 `schema`、`snapshotId`、`snapshotManifestDigest`、`publishedIdentityDigest`；export payload `writcraft.delivery-export-selection/v1` 为 `schema`、`authorityDigest`、`orderedFiles`、`warningDecision`、`deliveryManifestDigest`；artifact save payload `writcraft.docx-artifact-selection/v1` 为 `schema`、`artifactId`、`artifactDigest`、`authorityDigest`、`expiresAt`。ordered file item exact keys 为 `fileId`、`pageBreakBefore`。任一 payload 字段变化都生成不同 digest 并使旧 capability stale。
- operation-specific public 请求只使用 3.1.3 冻结的 schema；不接受正文、path、revision、manifest 或 output path。

#### 3.1.3 Renderer public projection

- snapshot list envelope：`schema`（`writcraft.snapshot-list/v1`）、`projectInstanceId`、`items`、`unavailableCount`、`capacity`。item：`snapshotId`、`createdAt`、`status`、`markdownCount`、`imageCount`、`totalBytes`、`snapshotManifestDigest`。capacity：`maxSnapshots`、`maxPrivateBytes`、`usedSnapshots`、`usedPrivateBytes`。
- delete preflight envelope：`schema`（`writcraft.snapshot-delete-preflight/v1`）、`projectInstanceId`、`snapshotId`、`createdAt`、`markdownCount`、`imageCount`、`totalBytes`、`snapshotManifestDigest`、`expiresAt`、`deleteCapabilityId`。
- restore preflight envelope：`schema`（`writcraft.snapshot-restore-preflight/v1`）、`projectInstanceId`、`snapshotId`、`selectedItems`、`writeCount`、`totalBytes`、`historySummary`、`expiresAt`、`restoreCapabilityId`；selected item 为 `fileId`、`displayPath`、`status`，historySummary 为 `changeSetId`、`fileCount`、`safeUndoAvailable`，不返回未选正文。
- comparison envelope：`schema`（`writcraft.snapshot-comparison-public/v1`）、`projectInstanceId`、`snapshotId`、`items`、`createdAt`、`comparisonDigest`、`compareCapabilityId`；public item 只含 `fileId`、`displayPath`、`kind`、`status`、`byteDelta`、`diffId`。
- snapshot diff page envelope：`schema`（`writcraft.snapshot-diff/v1`）、`projectInstanceId`、`snapshotId`、`diffId`、`fileId`、`pageIndex`、`pageCount`、`hunks`、`nextPageToken`、`truncated`。hunk：`oldStart`、`oldLines`、`newStart`、`newLines`、`lines`；line：`kind`（`context|delete|insert`）、`text`。这是 public projection 唯一允许返回的作者正文，必须由 Main 从绑定的 snapshot/current bytes 生成；每页最多 256 KiB、单文件完整 diff 最多 32 MiB、单次 comparison 全部完整 diff 最多 256 MiB。next token 是 compare capability 内的 opaque cursor，最后一页为 `null`；任何输出超限才设 `truncated=true`，该文件禁止签发 restore capability，不能把分页本身称为截断。
- delivery preflight envelope：`schema`（`writcraft.delivery-preflight/v1`）、`projectInstanceId`、`snapshotId`、`authorityDigest`、`selectedFiles`、`outline`、`health`、`blockers`、`warnings`、`canExport`、`exportCapabilityId`；public selected file 为 `fileId`、`displayPath`、`order`，public outline 为 `outlineId`、`fileId`、`level`、`text`、`ordinal`。public health item 为 `healthId`、`type`、`severity`、`reasonCode`、`subjectLabel`、`evidenceSummaries`、`nextAction`；evidence summary 为 `fileId`、`displayPath`、`locatorDigest`，nextAction 只允许 `ADD_SOURCE`、`REVIEW_LOCATOR`、`MERGE_SOURCE`、`ADD_EVIDENCE`、`FIX_FOOTNOTE`。阻断/partial/stale 时 `exportCapabilityId` 必须为 `null`。
- DOCX artifact public envelope：`schema`（`writcraft.docx-artifact-public/v1`）、`projectInstanceId`、`snapshotId`、`artifactId`、`byteLength`、`sha256`、`warnings`、`createdAt`、`expiresAt`、`artifactCapabilityId`；只有 build terminal truth 为 committed 且 package report valid 才返回非空 capability。
- local task envelope：`schema`（`writcraft.local-task/v1`）、`taskId`、`projectInstanceId`、`kind`、`stage`、`status`、`startedAt`、`elapsedMs`、`cancelAvailable`、`terminalTruth`、`errorCode`；不返回 AI attempt、root、正文、target 或 capability。Stage A 的 `kind` 只允许 `SNAPSHOT_CREATE|SNAPSHOT_COMPARE|SNAPSHOT_RESTORE|SNAPSHOT_DELETE`；`status` 只允许 `queued|running|cancelling|completed|failed`；`stage` 只允许 `preparing|settling_watcher|scanning_sources|writing_private_bundle|publishing_bundle|reconciling|reading_snapshot|comparing|preparing_restore|restoring_markdown|quarantining_snapshot|deleting_snapshot|completed`。`queued|running|cancelling` 时 `terminalTruth=null`、`errorCode=null` 且 stage 不得为 `completed`；terminal 时 stage 必须为 `completed`，`terminalTruth` 只允许 `UNCOMMITTED|COMMITTED|COMMITTED_RISK|UNKNOWN`，成功 `COMMITTED` 的 `errorCode=null`，其余 terminal 必须给稳定、无路径 ASCII error code。`cancelAvailable` 仅能在已运行至少 10 秒、`status=running` 且 stage 属于 `preparing|settling_watcher|scanning_sources|writing_private_bundle|reading_snapshot|comparing|preparing_restore` 时为 `true`；其他 status/stage、`elapsedMs < 10000`、`publishing_bundle|restoring_markdown|quarantining_snapshot|deleting_snapshot|reconciling|completed` 均必须为 `false`。创建与恢复 120 秒、比较 60 秒的 deadline 是 task owner 的终止请求，不把 rename 后超时推断成 `UNCOMMITTED`。

operation request exact schemas：

- list：`writcraft.snapshot-list-request/v1` → `schema`、`projectInstanceId`；
- create：`writcraft.snapshot-create-request/v1` → `schema`、`projectInstanceId`、`confirmation`，confirmation 必须为 `CREATE_SNAPSHOT`；
- compare：`writcraft.snapshot-compare-request/v1` → `schema`、`projectInstanceId`、`snapshotId`；diff read：`writcraft.snapshot-diff-request/v1` → `schema`、`projectInstanceId`、`compareCapabilityId`、`diffId`、`pageToken`，首页 `pageToken=null`，后续只接受上一页返回的 opaque token；
- restore prepare：`writcraft.snapshot-restore-prepare-request/v1` → `schema`、`projectInstanceId`、`compareCapabilityId`、`selectedIds`、`confirmation`，confirmation 必须为 `PREPARE_SELECTED_MARKDOWN_RESTORE`，返回 restore preflight；restore commit：`writcraft.snapshot-restore-request/v1` → `schema`、`projectInstanceId`、`restoreCapabilityId`、`confirmation`，confirmation 必须为 `RESTORE_SELECTED_MARKDOWN`；
- delete prepare：`writcraft.snapshot-delete-prepare-request/v1` → `schema`、`projectInstanceId`、`snapshotId`，返回上述 delete preflight；delete commit：`writcraft.snapshot-delete-request/v1` → `schema`、`projectInstanceId`、`deleteCapabilityId`、`confirmation`，confirmation 必须为 `DELETE_SNAPSHOT`；
- preflight：`writcraft.delivery-preflight-request/v1` → `schema`、`projectInstanceId`、`snapshotId`、`orderedFiles`、`warningDecision`。ordered file item 为 `fileId`、`pageBreakBefore`，最多 300 项、无重复；第一项 `pageBreakBefore=false`，其余每项由作者选择。warningDecision 只允许 `REVIEW_ONLY`、`CONTINUE_WITH_WARNINGS`；
- build：`writcraft.docx-build-request/v1` → `schema`、`projectInstanceId`、`exportCapabilityId`、`confirmation`，confirmation 必须为 `BUILD_DOCX`；save：`writcraft.docx-save-request/v1` → `schema`、`projectInstanceId`、`artifactCapabilityId`、`confirmation`，confirmation 必须为 `SAVE_DOCX`；
- cancel：`writcraft.local-task-cancel-request/v1` → `schema`、`projectInstanceId`、`taskId`、`confirmation`，confirmation 必须为 `CANCEL_LOCAL_OPERATION`。

每个非 Diff public envelope 最多 4 MiB；Diff 是唯一正文例外，每页/单文件/单次预算单独按上文 256 KiB/32 MiB/256 MiB 执行。数组上限继承私有 schema，额外字段、accessor、prototype pollution key、非普通对象和 getter 均拒绝。

#### 3.1.4 摘要 preimage

除 3.1.5 明确给出二进制 framing 的 `bundleObjectDigest` 外，所有摘要都采用同一无循环算法：`preimage = UTF8("writcraft-digest/v1") || byte(0x00) || UTF8(schema) || byte(0x00) || canonicalJson(objectWithoutOwnDigestField)`；若摘要存于对象自身，`objectWithoutOwnDigestField` 只删除最外层自身摘要键并保留其他嵌套摘要；若 digest 存在于外部 binding/父对象而 payload 没有自摘要键，则 canonicalize 完整 exact-key payload。结果为 `sha256:` 加完整 64 位小写十六进制。禁止把摘要键置空、用占位值、拼接字段、二次 stringify 或摘要截断。

- `snapshotManifestDigest` 排除 snapshot manifest 的 `snapshotManifestDigest`；
- `authorityDigest` 排除 delivery authority 的 `authorityDigest`，但保留 `snapshotManifestDigest` 与 `graphManifestDigest`；
- `manifestDigest` 排除 delivery manifest 的 `manifestDigest`，保留完整 authority；
- `receiptDigest`、`markerDigest`、`comparisonDigest` 分别只排除其同名最外层字段；
- `fileRevisionSetDigest` 的 schema 域为 `writcraft.file-revision-set/v1`，payload exact keys 为 `schema`、`items`，item 为按 path byte order 排序的 `fileId`、`path`、`revision`、`sha256`；
- `rootIdentityDigest`、`ancestorIdentityDigest`、`sourceObjectIdentityDigest` 和 locator digest 使用各自 `writcraft.*-identity/v1` exact-key payload，原始设备/inode/path 只留在私有 helper 进程与私有记录，不进入 public projection；snapshot 图片引用的 locator 单独使用本节冻结的 `writcraft.snapshot-image-token-locator/v1`，不伪造 block/offset locator；`bundleObjectDigest` 只使用 3.1.5 的 bundle object payload。

Main JavaScript 与 native helper 必须对同一 golden/hostile Unicode fixture 产生逐字节相同的 preimage 与 digest；任何无法复现的 digest 都按损坏处理，不能本地修补。

#### 3.1.5 Identity payload、字段上限与 bundle bytes

- root identity payload `writcraft.root-identity/v1`：`schema`、`dev`、`ino`、`uid`、`mode`；ancestor payload `writcraft.ancestor-identity/v1`：`schema`、`components`，component 为 `nameSha256`、`dev`、`ino`、`uid`、`mode`；object payload `writcraft.object-identity/v1`：`schema`、`dev`、`ino`、`uid`、`mode`、`nlink`、`size`、`mtimeNs`、`ctimeNs`、`contentSha256`；locator payload `writcraft.locator-identity/v1`：`schema`、`fileId`、`revision`、`blockId`、`start`、`end`、`quoteSha256`。`dev/ino/size/mtimeNs/ctimeNs` 永远编码为无符号、无前导零的十进制字符串（零只写 `"0"`）；`uid/mode/nlink/start/end` 永远为非负安全整数，禁止同一字段混用 number/string。
- snapshot image-token locator payload `writcraft.snapshot-image-token-locator/v1`：`schema`、`fileId`、`revision`、`tokenOrdinal`、`rawTokenSha256`、`hrefSha256`；摘要仍按 3.1.4 domain-separated canonical digest。它只证明 exact snapshot Markdown token 身份，不冒充可跳转的 block/UTF-16 range；阶段 B/D 如需跳转，必须从同一 immutable snapshot 与同一 parser authority 重建并校验受限 UI locator，不能从 ordinal 猜 offset。
- Markdown sealed-capture payload `writcraft.snapshot-capture-identity/v1`：`schema`、`transactionId`、`projectInstanceId`、`snapshotId`、`ownerGeneration`、`creationMutationGeneration`、`rootIdentityDigest`、`candidates`；candidate exact keys 为 `candidateId`、`fileId`、`revision`、`byteLength`、`sha256`、`ancestorIdentityDigest`、`sourceObjectIdentityDigest`，按 native scan 的 path-byte order 对应顺序排列且最多 300 项。`captureDigest` 是该完整 payload 的 3.1.4 external-binding digest，不删除任何字段；原始 path 只在 native 私有 scan record 中，不能进入 Main/Renderer token pass。helper 必须在发送 exact bytes 前持久绑定并复算该 payload；Main 只能原样回传 digest，不能生成或修补它。
- `projectInstanceId` 严格复用 `^instance_[a-f0-9]{24}$`；schema/reason/status/kind/confirmation 最多 96 ASCII bytes；opaque ID 最多 128 ASCII bytes；digest 固定 71 ASCII bytes（`sha256:` + 64 hex）；相对 path 最多 4096 UTF-8 bytes/1024 scalar；display path/title/label/alt/caption/nextAction 各最多 1024 UTF-8 bytes/512 scalar；URL 最多 4096 bytes；单个 Diff line text 最多 64 KiB，全部 Diff 仍受 3.1.3 总预算。超限不截断权威字段；display-only 字段可带显式 `truncated=true` 的对应 public schema，未含该键的 schema 不允许静默截断。
- bundle bytes 固定为：8-byte magic `57 43 53 42 01 00 00 00`；4-byte unsigned big-endian manifest length；manifest canonical UTF-8 bytes；4-byte unsigned big-endian entry count；随后按 manifest path UTF-8 byte order逐项写入 `4-byte header length + canonical UTF-8 entry header + 8-byte unsigned big-endian content length + exact content bytes`；最后写 32-byte raw SHA-256（覆盖 magic 到最后 content）与 8-byte footer `57 43 53 42 45 4e 44 01`。无 padding、对齐、可选字段或重复项。
- bundle entry header schema `writcraft.snapshot-bundle-entry/v1`，exact keys 为 `schema`、`fileId`、`path`、`kind`、`byteLength`、`sha256`；kind 只允许 `markdown|image`。header 与 manifest item 必须逐项一致；entry count 最多 500，manifest/header 各最多 4 MiB，content 合计最多 512 MiB，bundle 总长最多 520 MiB。任何 length 溢出、trailing byte、顺序差异、duplicate ID/path、footer/hash 不符或未完整消费都按损坏拒绝。
- `sourceObjectIdentityDigest` 是 3.1.5 object identity payload 的 3.1.4 摘要。
- `root-identity`、`ancestor-identity` 与 `object-identity` 不是只供命名的 key 列表：JS/native 都必须用 3.1.5 exact 类型、canonical 大整数和 hostile fixture 完整校验并复现摘要。任何接收 `parentIdentityDigest` 的 stage/published/quarantine validator 必须同时接收已验证 parent payload，重算 digest，并分别要求 parent role 为 `control|bundles|quarantine`；只检查 digest 字符串形状不构成 authority。
- private parent identity payload `writcraft.snapshot-private-parent-identity/v1` exact keys 为 `schema`、`role`、`rootIdentityDigest`、`dev`、`ino`、`uid`、`mode`；`role` 只允许 `control|bundles|quarantine`。它由 helper 在已绑定项目根 fd 下逐级 `openat(O_DIRECTORY|O_NOFOLLOW)` 后生成，不能从 path `stat` 拼装。
- snapshot stage identity payload `writcraft.snapshot-stage-identity/v1` exact keys 为 `schema`、`transactionId`、`snapshotId`、`parentIdentityDigest`、`stageBasenameSha256`、`dev`、`ino`、`uid`、`mode`、`nlink`、`size`、`bundlePayloadSha256`、`snapshotManifestDigest`；parent 必须是 role=`control` 的 exact private parent。
- published identity payload `writcraft.snapshot-published-identity/v1` exact keys 为 `schema`、`snapshotId`、`parentIdentityDigest`、`finalBasenameSha256`、`dev`、`ino`、`uid`、`mode`、`nlink`、`size`、`bundlePayloadSha256`、`snapshotManifestDigest`；parent 必须是 role=`bundles` 的 exact private parent。delete transaction 的 `sourceIdentityDigest` 必须逐字等于 create receipt 持有的该 `publishedIdentityDigest`，不能重新发明 source payload。
- snapshot quarantine identity payload `writcraft.snapshot-quarantine-identity/v1` exact keys 为 `schema`、`transactionId`、`snapshotId`、`parentIdentityDigest`、`quarantineBasenameSha256`、`dev`、`ino`、`uid`、`mode`、`nlink`、`size`、`bundlePayloadSha256`、`snapshotManifestDigest`；parent 必须是 role=`quarantine` 的 exact private parent。delete transaction 的 `quarantineIdentityDigest` 使用该 payload；delete receipt 的 `deletedIdentityDigest` 必须逐字等于 unlink 前最后一次完整重检得到的 `quarantineIdentityDigest`，不存在第四种 deleted identity 算法。
- `bundleObjectDigest` 的 exact preimage 为 `UTF8("writcraft-snapshot-object/v1") || byte(0x00) || uint32be(headerByteLength) || headerCanonicalUtf8 || uint64be(contentByteLength) || exactContentBytes`；结果使用 `sha256:` + 64 hex。禁止省略长度、改用 JSON array/base64 或复用 3.1.4 object-with-digest 算法。
- snapshot entry binding schema `writcraft.snapshot-entry-binding/v1` exact keys 为 `schema`、`snapshotId`、`bundlePayloadSha256`、`fileId`、`bundleObjectDigest`、`contentOffset`、`contentLength`、`entryBindingDigest`；offset/length 为非负安全整数，`entryBindingDigest` 排除自身后按 3.1.4 计算。它只由完整验证 bundle header/order/footer/hash 的 parser 产生。
- save volume identity payload `writcraft.save-volume-identity/v1` exact keys 为 `schema`、`deviceId`、`fsid0`、`fsid1`、`mountFlags`；`deviceId` 是无符号无前导零十进制字符串，`fsid0/fsid1` 是 macOS `int32_t` 原值的有符号十进制字符串（范围 `-2147483648..2147483647`，零只写 `"0"`，非零禁止前导零），`mountFlags` 是非负安全整数。save parent chain `writcraft.save-parent-chain/v1` exact keys 为 `schema`、`volumeIdentityDigest`、`components`，component 为 `nameSha256`、`dev`、`ino`、`uid`、`mode`；save stage identity `writcraft.save-stage-identity/v1` exact keys 为 `schema`、`parentChainDigest`、`stageBasenameSha256`、`dev`、`ino`、`uid`、`mode`、`nlink`、`size`、`artifactDigest`；expected/actual published identity 共用 schema `writcraft.save-published-identity/v1` 与 exact keys `schema`、`parentChainDigest`、`finalBasenameSha256`、`dev`、`ino`、`uid`、`mode`、`nlink`、`size`、`artifactDigest`。其余 native 大整数沿用 3.1.5 unsigned 十进制字符串规则，所有 digest 均按 3.1.4 计算；expected 与 actual 必须逐字段相同。

#### 3.1.6 Snapshot transaction 状态与 nullability（A-R1.1）

所有 transaction/recovery 字段始终存在；本节只允许明确列出的 `null`。receipt schema 只表示已证明 `COMMITTED` 的终态，不为失败伪造 receipt。

| record / state | 必须非 null | 必须为 null |
|---|---|---|
| create transaction `PREPARING` | `snapshotManifestDigest` | `receiptDigest`、`lastErrorCode`；`stageIdentityDigest` 在 stage 首次合格 `fstat` 前为 null、随后必须为 digest |
| create transaction `UNCOMMITTED` | `snapshotManifestDigest`、`lastErrorCode` | `receiptDigest`；`stageIdentityDigest` 可为 null（从未创建）或保留已清理 exact stage digest |
| create transaction `COMMITTED` | `stageIdentityDigest`、`snapshotManifestDigest`、`receiptDigest` | `lastErrorCode` |
| create transaction `UNKNOWN` | `snapshotManifestDigest`、`lastErrorCode` | `receiptDigest`；`stageIdentityDigest` 可为 null 或 digest |
| delete transaction `PREPARING` | `sourceIdentityDigest`、`snapshotManifestDigest` | `quarantineIdentityDigest`、`receiptDigest`、`lastErrorCode` |
| delete transaction `UNCOMMITTED` | `sourceIdentityDigest`、`snapshotManifestDigest`、`lastErrorCode` | `receiptDigest`；`quarantineIdentityDigest` 可为 null 或保留已回滚 exact quarantine digest |
| delete transaction `COMMITTED` | `sourceIdentityDigest`、`quarantineIdentityDigest`、`snapshotManifestDigest`、`receiptDigest` | `lastErrorCode` |
| delete transaction `UNKNOWN` | `sourceIdentityDigest`、`snapshotManifestDigest`、`lastErrorCode` | `receiptDigest`；`quarantineIdentityDigest` 可为 null 或 digest |

create/delete recovery marker 的 `state` 只允许 `PREPARING|UNCOMMITTED|COMMITTED|UNKNOWN`。Create marker 的 `expectedPublishedIdentityDigest` 在完整 stage fsync + held-fd 重检之前为 null，之后必须为 digest；delete marker 的 `expectedDeletedIdentityDigest` 在 quarantine reopen + full bundle/manifest 重检前为 null，之后必须为 digest。`COMMITTED` marker 的 expected digest 必须非 null 且与 receipt 对应 identity 相同；`UNCOMMITTED` 只能在 exact owned stage/quarantine cleanup 或 source rollback、final state 重检与全部所需目录 fsync 完成后持久化；`UNKNOWN` 不允许清理任何可能已提交的 final。所有 identity digest 使用 3.1.4 + 本节/3.1.5 exact payload，并加入 JS/native golden 与 hostile fixture。

### 3.2 Allowlist 与预算

V1 只纳入以下字节：

1. 非隐藏、项目内普通文件的 `.md` 或 `.markdown`（扩展名匹配大小写不敏感），包括 `edit.md`、`chapters/**/*.{md,markdown}`、`references/**/*.{md,markdown}` 和作者创建的其他公开 Markdown；其 exact bytes 必须可由 fatal UTF-8 decoder 完整解码，非法 UTF-8 是创建 blocker，不得用 replacement character 修补、截断或跳过；
2. 被纳入 Markdown 以相对路径明确引用、并位于项目根内的普通图片：`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`；
3. 同一图片只存一次字节对象，但 manifest 保留所有引用位置。

阶段 A 的图片引用闭包只允许使用仓库唯一的 `marked v18.0.6` token authority，禁止 native helper 自写第二套 Markdown 图片正则或让 Main 重新读取项目正文。具体冻结为两阶段 sealed capture：helper 在已绑定项目根的一次权威 scan 中以 descriptor-relative 方式打开、校验并封存每个 Markdown 的 exact bytes、完整 ancestor/leaf identity 与 digest，同时为每个候选 Markdown 签发仅在本次 transaction 内有效的 opaque candidate ID，并返回受限的 `candidateId + captureDigest + fileId + revision + exact UTF-8 bytes`；Main 只对 helper 返回的这些 sealed exact bytes 使用 §7.1 的共享 tokenizer，按 3.1.1 的 exact token-pass schema生成 image token identity 与相对引用，不重新读取项目文件。helper 必须验证 candidate ID、capture digest、file/revision binding、parser ID、token 数量/序列/预算与 transaction 归属，再从同一 sealed capture 决定唯一图片集合、复制图片并生成 bundle；任一 unknown/duplicate/cross-request/stale candidate 或 token 结果都 fail closed。这里的 “same-scan” 指同一个 native-owned sealed capture，不允许在 tokenizer 前后以 Main/Renderer 的第二次文件读取替代；发布前仍须按 §3.4 第 4 步重枚举 allowlist，并重走全部 Markdown/图片 ancestor 与 leaf identity、重新核对 digest。阶段 A 必须先把 vendored tokenizer 的唯一字节源迁入 `v0/src/shared/` 并用 Main/Renderer parity 与 hostile corpus 证明一致，之后才可把该流程接入 production create。

V1 排除 symlink、hard-link count 大于 1 的文件、socket/device/FIFO、绝对或越界引用、远程图片、未被 Markdown 引用的图片、其他附件，以及 `.writcraft/`、所有隐藏路径、`node_modules/`、`.git/`、缓存、日志、指标、Graph 派生文件、API Key 和应用 profile。排除项不能被静默纳入；正文引用到排除或越界资源时生成预检 blocker。

固定预算：

- 最多 300 个 Markdown（`.md|.markdown` 合计）、200 个唯一图片、500 个总文件项；
- 单个 Markdown 最多 4 MiB，Markdown 合计最多 64 MiB；
- 单个图片最多 25 MiB，单个 snapshot 总字节最多 512 MiB；
- 每项目最多 20 个已提交 snapshot、私有 snapshot 总量最多 2 GiB；
- 恢复一次最多选择 300 个 Markdown、总计最多 64 MiB。
- snapshot manifest 确定性 JSON 最多 4 MiB；单个 transaction/receipt/recovery 记录最多 1 MiB；上述元数据另计但必须先纳入 8 MiB 的单事务私有元数据总预算。

manifest 的 `budgets.limits` 必须逐字段等于上述冻结常量，不能作为可由 producer 自报放宽的参数；`observed.privateMetadataBytes` 也必须小于等于 8 MiB。JS、native helper 与 parser 使用同一组 golden 常量，任一不相等均视为损坏/不兼容而 fail closed。

任一预算超限、容量不足或预算计算不完整都 fail closed，不发布 snapshot、不自动删除旧 snapshot，也不降级成部分 snapshot。

### 3.3 私有存储

- 存储根为项目私有 `.writcraft/snapshots/v1/`，固定子目录只有 `bundles/`、`control/`、`quarantine/`；目录权限 `0700`、普通私有文件 `0600`。每个 snapshot 的 Markdown、图片、manifest 与对象表装入一个有界、不可变的 `writcraft.snapshot-bundle/v1` 普通文件，避免为一次事务创建无法原子取得 fd 的 stage/object 目录。
- Main 和原生 helper 都必须校验私有父目录、bundle、control、receipt、recovery marker 与 quarantine 的 owner、mode、type、identity 和 canonical parent。
- 私有目录中的未知、未来 schema、损坏记录或权限漂移不可自动删除；列为不可用并进入显式恢复/人工处理状态。

私有存储威胁模型明确分层：项目公开文件与所有 WritCraft 并发操作的 ancestor/leaf 替换、同 inode 改写和迟到结果都在保护范围；但一个已经取得当前 macOS 登录用户权限、主动篡改 `0700` `.writcraft/snapshots` 的恶意同 UID 进程无法由 POSIX path API 完全区分，V1 不宣称抵御该主机账户攻陷。此残余必须作为 P2 保留；不能把随机名或事后 `stat` 描述成同 UID 防护。若未来要把恶意同 UID 写者纳入威胁模型，必须先引入独立权限主体/受保护存储架构并重新复审。

### 3.4 创建与发布三态事务

创建流程固定为：

1. 获取 snapshot owner，再取得 owner-specific 项目共享写/扫描 lease。该 exact lease 被专用 barrier 允许通过，但所有其他 mutation 仍被拒绝；barrier 先等待旧 watcher in-flight polling，强制一次更新的完整 Markdown hash，drain 该 root 已排队的 watcher payload，使 `projectMutationGeneration` 先反映 barrier 前变化，再冻结 `project instance + owner generation + mutation generation`。随后原生 helper 执行一次独立有界的全量 Markdown/引用图片 same-scan copy；普通 `flush()` 返回的计数、旧 watcher snapshot 或稳定时间窗都不是 snapshot 字节权威。scan limit、watcher degradation、项目漂移、lease 漂移或 barrier 失败均停止。helper 发布前仍按第 4 步重枚举 allowlist 并重检全部来源，不能只比较 Renderer/Main generation。
2. 原生 helper 从 startup bind record 中的可信项目根 fd 开始，对每个外部 path component 做 no-follow `openat`，记录并重检完整 ancestor chain。allowlist、摘要和复制字节来自同一权威扫描。
3. helper 持有已验证 `control/` 目录 fd，以 `openat(O_CREAT|O_EXCL|O_RDWR|O_NOFOLLOW|O_CLOEXEC, 0600)` 原子创建不可猜测的单文件 stage 并直接取得 fd；首次写入前 `fstat` 必须证明 regular file、预期 uid/mode、`nlink === 1`、size 0，并记录 dev/ino。snapshot bundle 只通过该 fd 顺序写入，写入、`fsync` 后重检身份、大小和摘要。manifest/receipt 计入单独的序列化元数据预算。
4. 原子 no-clobber 发布前的最后一个动作是重走项目根链并重检全部来源身份与摘要；任何来源变化都使事务保持 uncommitted。
5. macOS helper 使用同文件系统 `renameatx_np(..., RENAME_EXCL)` 从 `control/` stage no-clobber 发布到 `bundles/`；不支持该原语或跨设备时 fail closed，不回退到 `exists→rename`。helper 在 rename 前后保持 stage fd，随后通过 `openat(O_NOFOLLOW)` 重开 final 并要求 dev/ino/size/digest 与 held fd 相同，执行两个父目录 fsync，并以新的 `O_CREAT|O_EXCL` control fd 持久化响应重建 receipt。

公开终态只有：

- `UNCOMMITTED`：已证明未发布，且 exact owned stage/control cleanup 与目录 fsync 全部成功；
- `COMMITTED`：published identity、manifest digest 和 receipt 均从磁盘证明，必要 fsync 已完成；
- `UNKNOWN`：primary 结果与独立 reconciliation 不能共同证明前两者，或提交/持久化风险未闭合。

只有 proven `UNCOMMITTED` 且 exact owned 的 stage 可以清理。`COMMITTED`/`UNKNOWN` 不得进入预提交清理。提交后响应丢失、fsync 失败或重试只补齐 reconciliation、fsync 和响应，不重新扫描、复制、覆盖或生成新 snapshot。

### 3.5 列表与安全删除

- 列表只返回已校验 manifest 的受限摘要；损坏/未知记录以不可用项呈现，不伪装成空列表。
- 删除 capability 绑定 `projectInstanceId + snapshotId + snapshotManifestDigest + published identity`，短期、单次、owner-specific。
- 删除 capability TTL 固定 5 分钟；比较/恢复 capability TTL 固定 10 分钟。到期不延长，重试需从 Main 当前真相重新签发。
- 原生 helper 先 `openat(O_NOFOLLOW)` 持有并校验 exact bundle，再用 `renameatx_np(..., RENAME_EXCL)` 原子 no-clobber 移入不可猜测的 `quarantine/` 名称，重开后要求 held fd 与 quarantine dev/ino/size/完整 bundle+manifest digest 一致，再执行删除与目录 fsync；不支持原语时 fail closed。
- 并发替换、hard link、同 inode 改写、父目录漂移或 capability 过期均 fail closed。只删除 quarantine 内经证明属于本事务的 exact identity。
- 删除同样发布 `UNCOMMITTED`、`COMMITTED`、`UNKNOWN`；已提交删除的响应丢失从 marker、receipt 和磁盘协调，不把“不存在”单独当作本事务成功。

阶段 A adversarial fixture 必须在 `open→renameatx_np`、`rename→reopen`、`reopen→unlink`、unlink 后 fsync 和 receipt 响应之间注入替换/同 inode 改写。前两段必须在任何错误对象删除前 fail closed；最后一段若由恶意同 UID 进程绕过私有目录威胁模型，只能记录上述 P2，不能扩写为已证明安全。

## 4. 比较与 Markdown 选择性恢复

### 4.1 比较

- Main 对 exact snapshot 与当前 watcher barrier 结果生成 `writcraft.snapshot-comparison/v1`。
- 文件状态固定为 `same`、`modified`、`missing`、`added`、`conflict`、`unavailable`；Markdown 附 Main 生成的有界正文 Diff，图片只显示 identity/摘要/大小状态。
- compare capability 绑定 project instance、snapshot identity、当前 mutation generation、当前 revision set、所列路径和到期时间。任一分量漂移必须重新比较。

### 4.2 恢复

1. Renderer 只能提交 compare capability 和作者选择的 opaque Markdown file IDs；Main 解析为相对路径和 snapshot 字节。
2. 只允许选择 snapshot 中的公开 `.md|.markdown`。`added` 当前文件永不自动删除；未选择文件和所有图片永不写入。
3. `modified` 选择写回现有 Markdown；`missing` 选择只允许在其全部项目内 ancestor 仍存在且通过 trusted-root descriptor-relative identity 校验时，以 `O_CREAT|O_EXCL|O_NOFOLLOW` 创建缺失 leaf。缺失 ancestor、目标竞争、symlink/hard link 或不可信 parent 一律 `conflict`，不创建目录。Main 在任何私有 stage 前再次校验 project/snapshot/capability/revision/path/ancestor identity，并复用既有多文件 History/recovery/authoritative reload/Safe Undo 事务边界。
4. 一次恢复是单个全有或全无的多文件 ChangeSet：任一所选文件预检失败则全部不提交；不允许把成功子集静默提交。
5. 预提交取消、冲突、能力过期或失败必须使公开 Markdown、History 和 recovery marker 零写入。
6. 已提交后发生 fsync、响应或 UI refresh 失败，必须先安装 authoritative tree/current-file/History truth，再返回 committed 或 committed-risk；不得重放恢复。
7. Safe Undo 只撤销该恢复实际写入的 Markdown，不触碰快照后新增文件、未选择文件或图片。

为闭合 `missing` 与最大合法 300 文件/64 MiB 恢复，Stage A 将既有 History 升级为 `writcraft.changes/v4`，同时继续只读兼容并确定性迁移 v1–v3；不得建立第二套 Snapshot restore history。v4 application file exact keys 为 `path`、`summary`、`before`、`after`、`createdIdentityDigest`；`before/after` exact keys 为 `exists`、`revision`、`contentHash`、`byteLength`、`encoding`、`data`。存在状态的 `revision/contentHash` 为 64 位小写 hex，`byteLength` 为 exact UTF-8 bytes，`encoding` 只允许 `utf8|base64`；snapshot restore 一律用 canonical RFC 4648 padded `base64` 保存 snapshot/current 的 exact raw bytes，避免 JSON escape amplification。由于 3.2 已把非法 UTF-8 Markdown 冻结为 snapshot 创建 blocker，这些 raw bytes 必须同时可由 fatal UTF-8 decoder 完整解码；恢复写回和 Safe Undo 必须逐字节复现，不能经过字符串 replacement/normalization。缺失状态固定为 `exists=false`、`revision=null`、`contentHash=null`、`byteLength=0`、`encoding=null`、`data=null`。普通既有 Changes 可继续使用 `utf8`，加载时必须重算 bytes/hash；不允许修补无效 base64。

v4 document exact keys 为 `schema`、`entries`，生产文档最多保留 100 条；新写入的 applied snapshot-restore application entry exact keys 为 `id`、`kind`、`changeSetId`、`status`、`appliedAt`、`files`、`provenance`、`integrity`，其中 `kind=application`、`status=applied`。Safe Undo 提交后的同一 entry 保留上述全部 authority 字段并追加 `undoneAt`，`status=undone`；`undoneAt` 只在该状态存在。provenance schema 为 `writcraft.snapshot-restore-history/v1`，exact keys 为 `schema`、`snapshotId`、`snapshotManifestDigest`、`restoreCapabilityId`、`comparisonDigest`、`selectedIds`；`selectedIds` 与 files 一一对应且最多 300 个。普通 undo 入口必须识别该 provenance 并路由到 Snapshot 专用预检/事务；不得把 `before.exists=false` 转成普通 ChangeSet 的 null 正文，也不得在 identity-bound quarantine 删除完成前把 History 标成 undone。

单条最大 fixture proof 与生产完整文档是两个不同职责。proof document 只含当前 snapshot-restore entry，用 concrete document/entry/provenance template 精确扣除空 `files=[]` 的两字节并替换为 300 个最大合法 file 的 canonical byte count，不能接受调用方自报 envelope；小型真实 record 必须对账 accountant 与完整 canonical JSON 实际字节数。生产 `changes/v4` envelope 允许 1–100 条，保留项必须先由既有 History 对应 kind validator 验证并冻结，当前 snapshot-restore entry 再由上述 exact validator 验证；随后对 FIFO 后完整 document 重新做冻结 JSON byte 计数。History v4 的 byte 计数是对验证并按冻结字段顺序重建后的 plain data document 执行无空白 `JSON.stringify`；这是 3.1.4 C0 禁令的唯一兼容例外，只允许既有普通 Changes 的 `before/after.encoding=utf8` 对应 `data` 保留并转义 Markdown 中的换行、制表等 C0。identity、path、schema、provenance、summary 和 snapshot restore 的 base64 data 仍使用各自严格 validator；不得借该例外接受 getter、extra key、稀疏数组、非安全数、无配对 surrogate 或自由结构。单条 proof validator 不得命名或用于冒充 production full-document validator；只有完整文档超过 192 MiB 才按既有 FIFO 丢弃最旧项，不能为了通过单条 validator 无条件清空其他合法 History。

`createdIdentityDigest` 只在 `before.exists=false && after.exists=true` 时非 null，payload schema `writcraft.restore-created-identity/v1` exact keys 为 `schema`、`parentIdentityDigest`、`leafNameSha256`、`dev`、`ino`、`uid`、`mode`、`nlink`、`size`、`contentSha256`，按 3.1.4 摘要；其他文件该字段必须为 null。这里的 leaf 是公开项目 Markdown，不是私有 snapshot 文件：`mode` 只要求 `0..65535` 的非负安全整数，`nlink` 必须为 1，不得复用私有文件 `0600` validator；parent 必须绑定已验证的项目内 ancestor identity payload。事务在 exact no-clobber create 后、History 持久化前从 held fd 生成该 digest。应用失败回滚或 Safe Undo 删除这种 leaf 时，必须先移入私有不可猜测 quarantine，重检 parent/leaf/inode/size/content digest 与 `createdIdentityDigest`，再 unlink + directory fsync；文件缺失、内容变化、同 inode 改写或 replacement 均 conflict，不能删除。Safe Undo 不删除 parent 目录。

单次 snapshot restore 仍最多 300 个 Markdown、snapshot after 合计 64 MiB；current before 与 snapshot after 合计最多 128 MiB。v4 restore record 使用 base64 后的完整 `changes.json` hard cap 冻结为 192 MiB，达到容量时可在写入前按既有 FIFO 规则丢弃最旧历史，但必须保留本次记录；若单条规范序列化记录仍超限则整个 restore preflight fail closed。ChangeSet/History 文件数与 byte gate 必须同步扩大到该冻结上限并有最大合法 fixture；不能静默拆成多个事务或成功子集。

snapshot restore 的 public/history path 必须复用 3.2 allowlist：任一 segment 为空、`.`、`..` 或以 `.` 开头均拒绝，尤其不得接受 `.writcraft/**`。COMMITTED create/delete transaction 的 authority validator 必须绑定并校验对应 receipt；若只做无 receipt 的结构读取，必须使用不宣称终态证明的独立 structural parser 名称，不能由 authority validator 接受。

## 5. Delivery Authority 与预检

### 5.1 唯一向量

`writcraft.delivery-authority/v1` 是以下全部分量的不可变摘要：

`projectInstanceId + snapshotId + snapshotManifestDigest + creationMutationGeneration + fileRevisionSetDigest + graphIdentity + graphManifestDigest + sourceIndexRevision`

Graph manifest 与 SourceIndex 输入必须明确绑定同一个 `snapshotId` 和 `fileRevisionSetDigest`。任一分量缺失、不一致、预算不完整或 stale 时可以返回只读 stale 报告，但不得签发 export capability。

向量按本合同确定性 JSON 序列化并取完整 SHA-256；不允许拼接可歧义字符串、截断摘要或以 Graph/SourceIndex 当前缓存时间代替 snapshot binding。预检 capability TTL 固定 10 分钟、单次签发、owner-specific；任何项目 mutation、Graph correction、SourceIndex revision、导出文件选择或 warning 决策变化都使它立即失效。

### 5.2 导出选择与顺序

- Main 从 snapshot manifest 建立可交付 Markdown catalog；`edit.md` 默认排除，不能被误当作正文。其他 Markdown 均可由作者显式选择。
- Renderer 提交有序 opaque file ID 列表；Main 冻结顺序并拒绝未知、重复、跨 snapshot 或 stale ID。
- 未显式选择任何正文是 blocker。导出不自动拼入 references 文件或项目 Prompt；被正文引用的来源只用于脚注/健康证据，除非作者也显式选择其 Markdown 为正文。

### 5.3 Manifest 与问题级别

Main 生成 `writcraft.delivery-manifest/v1`，至少包含 authority、选定正文、目录/标题层级、脚注、来源、图片、资源、Markdown 语法覆盖、健康项、blocker/warning 计数和受限 evidence locator。

- blocker：snapshot 损坏/不完整、路径越界、缺失或不可解码的被引用图片、重复/缺失脚注导致无法唯一绑定、authority stale、预算不完整、没有正文、无法表达且会丢失作品含义的结构。
- warning：可确定性降级但不丢正文含义的语法、缺少 alt/caption、单一证据、明确待补来源标记等。作者必须显式“带警告继续”，warning 摘要进入 DOCX manifest；界面不得称为全部通过。
- 预检、健康分析和修复建议完全离线且不写正文。修复动作若需要 AI，只能另行进入普通 Changes；旧 export capability 立即 stale。

## 6. 引用健康度

问题类型只允许：

1. `missing_source`：正文存在合同定义的明确待补来源标记，或 Graph 中结构化论点没有任何来源 binding；
2. `stale_locator`：结构化来源/正文 locator 的 revision 或 exact quote 不匹配；
3. `duplicate_source`：规范化 URL 完全相同，或来源内容 SHA-256 完全相同；标题相似不构成证明；
4. `single_evidence`：一个结构化论点只有一条通过当前 revision 校验的 evidence；只能称“证据单一”；
5. `broken_footnote`：脚注引用没有唯一同名定义、定义重复、定义未被引用，或同一引用无法唯一绑定。

每项 schema 为 `writcraft.citation-health-item/v1`，必须有稳定 ID、type、severity、reason code、snapshot/revision binding、一个或多个 Main 校验过的 evidence locator 和可执行的本地下一步。不得用自由文本推断来源身份、裁定观点真伪、在线搜索、自动补来源或把 warning 升格为事实错误。

确定性算法冻结如下：

- 明确待补来源标记复用既有 Main `consistency-engine` 的四种确定性语法：`【待补来源】`、`[待补来源]`、`[citation needed]`、`<!-- citation-needed -->`；允许语法内部既有空白与英文大小写规则，不增加第五种 marker。Front Matter、fenced code 和 `edit.md` 内的命中继续按现有诊断器排除；其他自然语言“待引用”“需要来源”等不产生权威问题。阶段 B 必须把既有 `evidence_gap` 输入适配为 public `missing_source`，不得复制第二套扫描或 marker parser。
- 已存在文稿的 footnote ID 兼容语法为 Unicode Letter/Number 加 `_.:-`，1–128 个 Unicode scalar、禁止空白/C0/unpaired surrogate；引用为 `[^id]`，定义为行首 `[^id]:`。未来 shared formatter 新生成 key 最多 64 scalar，追加碰撞 suffix 前必须先截短 base；既有中文 key（如 `写作研究-2025`）不得被判坏。DOCX 内部 footnote 使用按首次引用顺序分配的正整数 ID，不把 Markdown key 强制 ASCII 化，也不重写作者文稿。同一 key 可以多次引用但只能有一个定义。
- citation `displayUrl` 与 SourceIndex URL 保持现有安全 WHATWG HTTP(S) 序列化并保留 fragment，不改已插入引用。`duplicateIdentityUrl` 是仅供 `duplicate_source` 的派生值：从该安全 URL 的副本移除 fragment，保留 path/query 原序与 tracking 参数；它不回写 SourceIndex、Citation 或正文。duplicate identity URL 完全相同或 snapshot 来源内容 SHA-256 完全相同才算重复；标题相似永不算证明。
- evidence 先按 Graph/SourceIndex stable ID 去重；`single_evidence` 的一条 evidence 必须通过 snapshot revision、block、quote 和 digest 校验。
- health stable ID payload schema 为 `writcraft.citation-health-id/v1`，exact keys 为 `schema`、`type`、`snapshotId`、`subjectId`、`evidenceIds`、`reasonCode`；`evidenceIds` 排序后用 3.1.4 canonical object digest，禁止字符串拼接。路径不参与文本规范化，展示文案不参与身份。
- SourceIndex/Graph 任一 partial、warning、scan-limit 或 budget-limit 都使健康报告 `partial`，所有结果只读且不得铸造 export capability。

结构化“论点有来源 binding”只允许三条路径，其他自由文本关系一律不算：

1. Graph v2 已存在的 `claim` 节点通过 `cites` edge 指向已存在的 `source` 节点，edge、两端 node 和全部 evidence 均通过 snapshot revision/quote/digest；阶段 B 不给 Graph node 增加第二 identity，而是按 source node 的 evidence `path + revision + content digest` 与 SourceIndex item 唯一匹配，并把结果写入 3.1.2 同一 `graphIdentity` 的 `sourceBindings` 表；
2. Graph v2 `supports|contradicts` edge 的一端已经是 `source|datum`、另一端已经是 `claim`，并通过同一 `sourceBindings` 唯一映射；当前 Graph 把普通自然语言关系产成 entity 时不得在阶段 B 猜测或改型，普通 entity→entity/claim→claim 的“支持/反驳”不是来源。Stage B 的确定性正例直接使用 schema-valid、同 identity 的 claim/source Graph fixture；生产没有这类节点时不伪造 health claim；阶段 D 若增强提取，只能在既有 `writcraft.graph/v2` analyzer 内完成并重新建立同一 binding；
3. claim 所在 frozen Markdown block 内存在唯一 footnote reference，其唯一 definition 含既有 `<!-- writcraft-source:src_... -->` marker，marker ID 唯一对应 SourceIndex item，reference/definition locator 均通过 exact snapshot 校验。

五类 reason/severity/export 映射冻结为：

| type | reasonCode | severity | export |
|---|---|---|---|
| `missing_source` | `EXPLICIT_SOURCE_NEEDED_MARKER`、`CLAIM_WITHOUT_SOURCE_BINDING` | warning | 作者显式带警告继续 |
| `stale_locator` | `GRAPH_EVIDENCE_REVISION_STALE`、`GRAPH_EVIDENCE_QUOTE_STALE`、`SOURCE_LOCATOR_REVISION_STALE`、`SOURCE_LOCATOR_QUOTE_STALE`、`SOURCE_ID_UNBOUND` | blocker | 禁止 capability |
| `duplicate_source` | `DUPLICATE_IDENTITY_URL`、`DUPLICATE_CONTENT_DIGEST` | warning | 作者显式带警告继续 |
| `single_evidence` | `CLAIM_SINGLE_VALID_EVIDENCE` | warning | 作者显式带警告继续 |
| `broken_footnote` | `REFERENCE_MISSING_DEFINITION`、`DEFINITION_DUPLICATE`、`REFERENCE_AMBIGUOUS` | blocker | 禁止 capability |
| `broken_footnote` | `DEFINITION_UNUSED` | warning | 作者显式带警告继续 |

去重根因 payload schema 为 `writcraft.citation-health-root/v1`，exact keys 为 `schema`、`snapshotId`、`type`、`subjectId`、`footnoteKey`、`reasonCode`；不适用值为 `null`，按 3.1.4 canonical digest。同一根因聚合排序后的全部 evidence，不能按 locator 重复报多项。每个 reason 必须有正例、相邻自然语言/标题相似/claim→claim、revision/quote stale 反例和跨 snapshot 否定 fixture；仅 fragment 不同、移除 fragment 后相同的两条安全 URL 必须是 `DUPLICATE_IDENTITY_URL` 正例，同时证明两个 `displayUrl` 保持原 fragment。blocker 计数大于 0、报告 partial/stale 或任一 binding 不唯一时 `canExport=false` 且 capability 为 `null`。

## 7. DOCX V1

### 7.1 支持的 Markdown 子集

Snapshot 图片发现、预检与 DOCX 编译唯一 token authority 为仓库现有、已 vendored 的 `marked v18.0.6`（当前字节 SHA-256 `62ad5de5bea6d79b4c47e5c0b5cbe4be61e25ee8994595c2cc0969b2a144cc5d`），固定选项 `gfm: true`、`pedantic: false`、`breaks: false`、`async: false`。阶段 A 先把这组纯 tokenizer/parser 字节从 Renderer 迁移到 `v0/src/shared/`，以支持 §3.2 的 sealed capture image-token pass；Main 与 Renderer 必须共同消费同一模块并做 token parity，Main 不导入 Renderer 文件、不另写 Markdown 正则扫描器。阶段 B 在同一 token authority 上增加预检/Footnote 支持；Footnote 是 WritCraft 在同一 token stream/源 offset 上的冻结扩展，不能另行全文解析。parser 版本或 hash 变化必须先更新合同和最大/hostile fixture。

DOCX 编译器必须确定性支持：

- UTF-8 段落与软/硬换行；
- ATX 标题 H1–H6，并生成对应 Word heading style；
- 粗体、斜体、删除线、行内代码；
- 有序/无序列表与最多 3 层嵌套；
- blockquote、fenced code block、thematic break；
- Markdown 链接（显示文本和 URL）；
- GFM pipe table 的矩形简单表格；
- 项目内相对 PNG/JPEG 图片及 alt/caption（缺失 caption 可 warning，不自动生成）；
- `[^id]` 脚注引用与唯一 `[^id]:` 定义，编译为真正的 Word footnote part，而不是正文尾注文本。

V1 不支持或不承诺：raw HTML、脚本、iframe、远程图片、SVG、Mermaid、数学公式、音视频、嵌套表格、跨文件自定义锚点、复杂 CSS、track changes、目录域自动刷新、出版级排版和外部模板。可保留字面文本的语法必须 warning；会静默丢正文/证据或产生不安全外部关系的语法必须 blocker。

YAML Front Matter 不进入正文；仅当它是文件起始处由 `---` 包围、总计不超过 16 KiB 的简单 scalar map 时作为预检 metadata。复杂 YAML、未闭合 Front Matter 或执行型 tag/alias 是 blocker；编译器从不执行 YAML。文件边界默认插入分页符；作者可在导出选择中关闭单个边界分页，但不能提交自由 CSS 或 OOXML。

图片 token 合同冻结为：

- direct `![alt](relative/path.png "caption")` 与 reference-style `![alt][id]` + 唯一 `[id]: relative/path.png "caption"` 都由同一 marked token stream 解析；重复/缺失 definition 为 blocker。`alt` 来自 image token 的纯文本，optional quoted title 是唯一 caption 来源；没有 title 即 caption 缺失 warning。V1 不新增 alt/caption 编辑器，也不借生成 prompt 补写。
- href 必须是无 query/fragment 的项目相对路径；反斜杠、绝对路径、URL scheme、network path、NUL、空 component、`.`/`..`、无效 percent escape 均 blocker。percent decode 只执行一次，解码后重新跑同一 path/extension 校验；encoded slash/backslash/dot traversal 均拒绝。
- Snapshot 可冻结 `.png|.jpg|.jpeg|.gif|.webp` 供比较；DOCX v1 只编译通过验证的 PNG/JPEG。被选正文引用 GIF/WebP 时返回 `UNSUPPORTED_DELIVERY_IMAGE_FORMAT` blocker，不转码、不静默取首帧；这不影响 snapshot 完整性。
- PNG 必须匹配 8-byte signature、唯一 IHDR 和 CRC/尺寸边界；JPEG 必须匹配 SOI/EOI、合法 segment 和唯一受支持 SOF 尺寸；扩展名、sniffed MIME 与 manifest MIME 必须一致。损坏、polyglot/尾随不允许结构、动画/多帧、零尺寸均 blocker。
- 单图仍受 25 MiB 压缩字节上限；width/height 各最多 16,384，单图最多 40,000,000 pixels，估算 RGBA 解码最多 160 MiB；Snapshot 最多冻结 200 张唯一图片，但一个 DOCX 最多选择 40 张唯一 PNG/JPEG、合计最多 200,000,000 pixels 与 512 MiB snapshot 图片字节。header parser 在完整 decode 前执行预算，任何未知尺寸或预算溢出都 fail closed。

“可解码”生产权威固定为 macOS ImageIO/CoreGraphics（系统 `/System/Library/Frameworks/ImageIO.framework` 与 `CoreGraphics.framework`），由 native helper 的 `decode-image-v1` 子命令读取；不接受 image path、URL 或不存在的独立 object fd。Main/helper 传入已验证并保持打开的 bundle fd，以及 3.1.5 `snapshot-entry-binding/v1`；helper 复核 bundle fd 的 published identity/footer hash，用 `pread` 只读 exact `contentOffset/contentLength`，要求读取长度、原始 SHA-256 与 `bundleObjectDigest` 全部匹配，并在 decode 后再次 fstat/rehash binding。流程固定为：结构/header 预算先通过 → `CGImageSourceCreateWithData` → 要求 `CGImageSourceGetCount == 1`、UTI/MIME 与 manifest 一致 → 读取 properties 并复核 dimensions/pixel budget → `CGImageSourceCreateImageAtIndex` → 在 8-bit RGBA bitmap context 中完整 draw 以强制解码全部 IDAT/entropy 数据 → 丢弃像素，只返回 `mimeType/pixelWidth/pixelHeight/frameCount/decodeDigest`。decodeDigest 的 payload exact keys 为 `schema`（`writcraft.image-decode/v1`）、`sha256`、`mimeType`、`pixelWidth`、`pixelHeight`、`frameCount`。

每图解码在独立 worker 中执行，deadline 5 秒、地址空间上限 1 GiB、输出 metadata 最多 4 KiB；最多并发 2 个 worker。单 worker 预算闭包固定为输入 25 MiB + RGBA target 160 MiB + ImageIO/CGImage second full-frame reserve 160 MiB + framework/allocator/virtual mapping reserve 512 MiB + 167 MiB safety margin，不允许第三个 full-frame buffer。40 图即使每个耗尽 5 秒也最多 20 批/100 秒，留在 preflight 120 秒 deadline 内；超出该图片数直接 blocker。signal、timeout、allocation failure、ImageIO warning/error、draw failure 或 metadata 不一致均为 `DELIVERY_IMAGE_DECODE_FAILED` blocker，不回退 Electron `nativeImage` 或扩展名判断。阶段 B 必须让单张 40,000,000-pixel 最大合法 fixture 与 40 图最大数量 fixture 在上述真实 worker 限额内通过，并包含 CRC/segment 合法但 IDAT/entropy 损坏的 PNG/JPEG，证明 header 通过而强制 draw 失败；阶段 E 若 macOS/ImageIO build 漂移，重新记录环境并复审真实 fixture。

### 7.2 OOXML 包合同

- 输出为无宏 `.docx` ZIP/OPC 包，遵循 ECMA-376 Office Open XML 与 WordprocessingML；不得包含外部 relationship、宏、OLE、ActiveX、custom XML、远程模板或追踪像素。
- 必需 part 至少包含 `[Content_Types].xml`、`_rels/.rels`、`word/document.xml`、`word/_rels/document.xml.rels`、`word/styles.xml`、`word/numbering.xml`；存在图片/脚注时包含相应 media、relationship、`word/footnotes.xml` 和 content type。
- 编译后必须执行：ZIP entry 名/数量/压缩与解压预算检查；重复 entry、绝对/`..` path、symlink entry 和 zip bomb 防护；所有 XML `xmllint --noout` 等价的 well-formedness；Content Types 唯一覆盖；root/main-document relationship；内部 relationship target 存在且不越界；relationship ID 唯一；图片 content type 与摘要匹配；脚注/编号/style 引用完整；禁止 external target；解包后重新计算 DOCX artifact SHA-256。
- DOCX 固定 package 预算：最多 1024 个 ZIP entry；单个 XML part 最多 128 MiB、其他单 entry 最多 32 MiB；压缩包最多 640 MiB、解压后全部 entry 最多 768 MiB；任何 entry 压缩比超过 100:1、重复 normalized name、ZIP64、多盘、加密或 data descriptor 无界长度均拒绝。生产 writer 在追加每个 entry 前累计 exact header/name/extra/data 字节并先拒绝越界，解析器使用相同字节定义。
- V1 不宣称拥有完整 ECMA XSD 全词汇验证器。由于生产编译器只生成冻结子集，专项必须对每个生成元素/属性执行严格 allowlist schema 验证；出现未知生成标记即失败。真实 Pages 打开与渲染是独立门禁，不能替代 package/schema 检查。

阶段 C 采用受控 WordprocessingML XML writer，并固定使用 `fflate@0.8.3`（MIT）生成/读取 bounded ZIP、`saxes@6.0.0`（ISC）执行严格流式 XML well-formedness；不引入高层 DOCX 模板引擎，不调用系统 `zip`/`unzip`/Office 自动化完成生产编译。两项依赖在进入阶段 C 的实现批次才写入 lockfile，并必须通过许可证、npm allowlist、包体积、恶意 ZIP/XML 和离线打包验证。测试中的 `/usr/bin/unzip` 与 `/usr/bin/xmllint` 是独立交叉检查，不是生产运行依赖。

### 7.3 构建与安全保存

1. DOCX compiler 只读 snapshot bundle bytes 和冻结 delivery manifest，不读取当前项目正文。它不创建 build dir；helper 在已验证 `control/` 父 fd 下以 `openat(O_CREAT|O_EXCL|O_RDWR|O_NOFOLLOW|O_CLOEXEC, 0600)` 原子创建单个 artifact stage fd，首写前执行与 3.4 相同的资格证明。
2. Main/worker 在有界内存中生成 entry 并顺序写入该 fd，完成 package/schema 校验、artifact digest、fd fsync 与 identity 重检后才打开原生保存对话框。
3. 保存对话框只允许 `.docx`；Renderer 不看或提交输出路径。取消为零目标写入。
4. Electron 43 `showSaveDialog` 只把 `filePath` 返回给 Main；该值不进入 Renderer、preload 或日志。V1 不启用 `securityScopedBookmarks`，因为目标不存在时 Electron 可能预先创建空文件，会破坏 no-clobber/零写入合同。Main 只把 absolute target 通过 native helper startup bind record 传入一次；helper 从可信 filesystem-root directory fd 开始逐 component `openat(O_DIRECTORY|O_NOFOLLOW)` 到父目录并在打开前后重走完整 chain，不把 `open(targetPath)` 当作根权威。
5. helper 先确认 final basename 合法且不存在，然后在同一目标父目录以不可猜测 hidden basename 和 `openat(O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW|O_CLOEXEC, 0600)` 原子创建 stage fd；首次写入前证明 uid/mode/nlink/size/dev/ino，复制 exact artifact、fsync、重检 size/digest/父链，最后以 `renameatx_np(stage, final, RENAME_EXCL)` 原子发布。持有 stage fd 跨 rename，重开 final 要求同 dev/ino/size/digest，fsync 父目录后写 receipt；任何平台不支持、跨设备或 final 竞争都 fail closed，不回退 `exists→rename`，失败前 final 始终不存在。
6. 事务状态为 `UNCOMMITTED`、`COMMITTED`、`UNKNOWN`。提交后异常通过 independent final identity、artifact digest、held fd、receipt 和目录 fsync 协调；只有 proven uncommitted 且 dev/ino/digest 仍等于 owned stage 才能清理 hidden stage，`COMMITTED`/`UNKNOWN` 不得删除 final 或按预提交失败清理。
7. 用户可重新选择另一个不存在的文件名，但每次保存都有新的 owner/capability；不能复用旧对话框结果或 stale artifact capability。

任意 target 写入前，Main/helper 必须先把 save target binding 与 recovery marker 以 `O_CREAT|O_EXCL` 写入应用私有 profile 的 `writcraft-export-recovery/v1/` 并 fsync；stage 创建后持久化 `stageIdentityDigest`，rename 前用 held stage dev/ino/size/artifact digest 与 final parent chain/basename 的 exact payload生成 `expectedPublishedIdentityDigest`，rename 后填入 `publishedIdentityDigest`。重启 reconciliation 只能从 marker 的 `targetBindingDigest` 解析 private target binding，重新从 filesystem-root fd 遍历 parent，分别检查 exact hidden stage 与 final：只匹配 stage → 仅进入受控 precommit cleanup，只有 exact stage unlink、重检 final 仍不存在和父目录 fsync 全部成功后才持久化 `UNCOMMITTED`；只匹配 expected final → `COMMITTED` 并补 fsync/receipt；二者都不匹配、都存在或父链漂移 → `UNKNOWN`。终态 receipt/响应安装前不得删除 binding/marker；清理也只针对匹配 digest 的 private control record，不扫描任意用户目录。

编译完成后的 artifact capability TTL 固定 10 分钟；打开保存对话框时冻结 owner，选择完成后立即单次消费。保存对话框持续期间只允许同一 window/project owner；项目切换、window 销毁或 snapshot 删除立即失效，失效结果即使迟到也不得写目标。

## 8. Graph 四视图

- 关系图、时间线、实体表、论点—证据表消费同一个冻结 `writcraft.graph/v2` identity、graph manifest digest、filters、corrections、Issue state 和 evidence set。
- 切换视图不调用模型、不重建 Graph、不改变正文。scope、filter、selected evidence、键盘焦点语义、可访问名称和 return location 跨视图保持。
- 时间线只投影具有结构化时间字段/关系的节点和 evidence，不从叙述自由文本猜日期。
- 时间线的确定输入仅为 `time`/`event` 节点，以及 `before`、`after`、`occurs_at`、`starts_at`、`ends_at`、`birth`、`death` 边；按 canonical date、节点 ID、edge ID 稳定排序。缺日期只进入“未定位时间”分组，不推断日期。
- 实体表只列 Graph v2 `nodes`，字段固定为 node ID、type、label、status、sorted aliases、sorted attributes、evidence count；按 type、label、ID 稳定排序。
- 论点—证据表只列 `claim` 节点及其 `supports`、`contradicts`、`cites` 边和绑定 evidence；按 claim ID、relation、edge ID 排序。无 evidence 可生成 `missing_source`，单一 evidence 可生成 `single_evidence`，但不判断真伪。
- 关系图继续使用同一 nodes/edges/evidence，不改变已有布局权威。四视图的 public projection 都带同一个 `graphIdentity` 与 `graphManifestDigest`，且不得自造 view-specific node/edge identity。
- 每个节点、事件、行、论点和健康项只能通过 Main 校验的相对 path + revision + locator 返回正文；stale 时只显示证据摘要并禁止跳转/修复 capability。
- 保留现有 300 文件/500 节点性能、关系图交互和可访问性基线；表视图绿灯不能替代关系图回归。

## 9. 本地任务所有权与 UI

- Snapshot 创建、比较/恢复、预检、DOCX 编译、保存各自使用 owner-specific generation 和 project instance；它们不是 AI task。
- 2 秒后显示真实阶段；10 秒后提供取消；默认 deadline：snapshot 创建 120 秒、比较 60 秒、恢复 120 秒、预检 120 秒、DOCX 编译/校验 180 秒。保存对话框等待用户期间不计入编译 deadline，但窗口/项目销毁立即使 owner 失效。
- helper 在每个内部 await/worker readiness/test hook 后、任何状态/UI/文件/capability mutation 前重检 exact owner generation 和 project instance。
- 终态文案必须区分：未开始、已取消且零写入、未提交、已提交、已提交但响应/持久化风险待协调、未知。旧 finally 不得释放新 owner 或覆盖新项目 UI。

## 10. 真实渲染与固定 fixture

### 10.1 冻结环境

- 主应用：Apple Pages `14.4`，build `7043.0.93`，位于 `/Applications/Pages.app`。
- 主系统基线：macOS `26.5.1` build `25F80`，Apple Silicon arm64。
- 阶段 0 工具基线：Node `26.3.1`、npm `11.16.0`、`/usr/bin/unzip`、`/usr/bin/xmllint`。
- 若阶段 C/E 时 Pages exact build 缺失或变化，必须记录为环境漂移并重新冻结/复审；不得临时换 Word/LibreOffice 取得绿灯。

### 10.2 固定 fixture

`v0/tests/fixtures/delivery-v1/` 后续必须包含内容公开、无真实作者信息的 fixture：

- 中英文、emoji 和合法 surrogate pair；最大字段/最大项目 envelope；
- H1–H6、段落、粗斜体、删除线、行内/块代码、三级列表、引用、分隔线、链接、简单表格；
- 至少 3 个脚注（重复引用、ASCII 与中文合法 ID、跨选中文件），以及 oversized/whitespace ID、missing/duplicate 定义拒绝反例和 legacy formatter 兼容例；
- 至少 2 张本地图片（PNG/JPEG），含 direct/reference-style、alt、quoted-title caption、无 caption、分页边界、signature/MIME/像素超限、GIF/WebP、损坏/缺失/越界/远程反例；
- 至少两个选中 Markdown（一个 `.md`、一个 `.markdown`），证明稳定顺序、目录和分页；
- C0 control、unpaired surrogate、XML metacharacter、ZIP path、relationship 和压缩预算攻击反例。

### 10.3 通过口径

自动化产物包括 package/schema 报告、artifact SHA-256、固定页数/文本段落/标题/脚注/图片计数和 Pages 导出的只读 PDF 渲染摘要；不得提交真实作者内容或绝对路径。

Computer Use 必须真实执行：用 Pages 打开 exact `.docx`，确认无修复、兼容或缺失字体阻断提示；检查标题层级、正文、中英文/emoji、三级列表、脚注跳转、表格、至少一张 PNG/JPEG、分页和文末；关闭且不保存对 DOCX 的二次修改。人工结果与截图只记录 fixture，不记录作者项目。

## 11. 失败矩阵

Renderer 可见失败只使用以下稳定、无路径 code；内部异常不得穿透 IPC：`SNAPSHOT_BUSY`、`SNAPSHOT_BARRIER_FAILED`、`SNAPSHOT_BUDGET_EXCEEDED`、`SNAPSHOT_CAPACITY_EXCEEDED`、`SNAPSHOT_STALE`、`SNAPSHOT_CONFLICT`、`SNAPSHOT_OUTCOME_UNKNOWN`、`DELIVERY_STALE`、`DELIVERY_PARTIAL`、`DELIVERY_BLOCKED`、`DOCX_BUILD_FAILED`、`DOCX_INVALID_PACKAGE`、`EXPORT_TARGET_EXISTS`、`EXPORT_CANCELED`、`EXPORT_OUTCOME_UNKNOWN`、`LOCAL_OPERATION_TIMEOUT`。提交后的 `COMMITTED`/`UNKNOWN` 事务真相是独立字段，不能仅靠 error code 推断。

| 边界 | 必须结果 |
|---|---|
| watcher/barrier/预算/权限失败 | 不发布 snapshot，不继续预检或导出 |
| snapshot 创建取消/失败 | 无半可用 snapshot；仅 proven owned/uncommitted stage 可清理 |
| 创建提交后响应/fsync 失败 | reconcile 为 committed/unknown；不重复制、不预提交清理 |
| 删除竞争/身份漂移/响应丢失 | exact quarantine fail closed；从持久化真相协调三态 |
| compare 后项目/snapshot 漂移 | capability 失效，重新比较 |
| 恢复取消/冲突/预提交失败 | Markdown、图片、History、marker 零写入 |
| 恢复提交后 UI/响应失败 | 安装 authoritative Markdown/History truth，不重放 |
| 当前图片相对 snapshot 漂移 | 显示差异；snapshot 字节完整则仍可 exact 导出 |
| snapshot 图片损坏/缺失/digest 不符 | blocker；不借当前项目或 Trash 字节 |
| health/Graph/SourceIndex stale | 只读 stale；禁止跳转、修复和 export capability |
| 只有 warning | 作者显式继续；DOCX 保留 warning 摘要 |
| DOCX build/schema/fsync 失败 | 不打开保存或保持目标不存在/原样 |
| 保存取消/目标存在/目标竞争 | 零目标写入，不覆盖 |
| 保存提交后响应丢失 | 按 identity/digest/receipt 返回 committed 或 unknown |
| 项目切换/窗口销毁/迟到结果 | 旧 owner 失效，不进入新项目 UI/文件系统 |

## 12. 阶段与验证门禁

0.4.0 当前执行同时受 [`WRC-0.4.0-EXEC-R1`](0.4.0-EXECUTION-PROTOCOL.md) 约束。该协议只收紧派工、WIP、复审和证据，不改变本合同的产品/安全语义。

- 阶段 A：Snapshot service/native helper/handler/preload/Renderer、列表/删除、比较/恢复、三态与故障注入；不得开始 DOCX 编译。
- 阶段 B：exact-snapshot delivery manifest、共享 citation authority、五类健康项；完全离线、零正文写入。
- 阶段 C：冻结子集 DOCX、严格 package/schema 校验、Main 保存对话框、原生 no-clobber 与 committed reconciliation、Pages fixture 打开。
- 阶段 D：同一 Graph v2 四视图和 snapshot→预检→修复→重新 snapshot→导出的连续体验。
- 阶段 E：所有者指定源项目的生产隔离副本、源摘要不变、真实 Pages 打开、全量回归、真实 Electron/Computer Use 和独立复审。

每阶段必须保留首红，运行相关专项、`npm test`、`npm run verify`、受影响真实 Electron，并分别记录代码、自动化、真实 Electron、真实作者、外部发布授权。外部 npm、dist-tag、GitHub Release/Tag、push 和 App/ZIP 分发始终需要新的单独授权。

阶段签收还必须满足：

- 前一阶段产物由其生产 App/Main 入口创建；direct storage seed 只能证明下游纯层，不证明跨阶段集成；
- filesystem/fd/journal/receipt/capability/package 结论必须使用 production adapter 和真实故障边界，fake/injected 层不能自签；
- 所有新增/改名验证脚本进入当前 stage/candidate 顶级 npm gate，未注册即不得退出阶段；
- 同类 authority/state-transition P1 连续两轮复审仍出现时，停止补丁并重新冻结完整状态/失败矩阵；
- 当前 Stage A 与真实 A→B 连续旅程签收前，不得实现 Stage C/D/E。

## 13. 阶段 0 退出清单

- [x] Snapshot allowlist、容量、三态创建/发布和安全删除合同已冻结。
- [x] Markdown-only 选择性恢复、图片比较/exact-snapshot 导出边界已冻结。
- [x] delivery authority、导出选择、blocker/warning 与五类健康项已冻结。
- [x] citation 单一共享权威、Graph 四视图连续性已冻结。
- [x] DOCX 子集、OOXML package/schema、no-clobber 保存与 committed reconciliation 已冻结。
- [x] Pages exact 版本、固定 fixture、自动化产物和人工视觉清单已冻结。
- [x] 当前源码/测试基线、`npm test`、`npm run verify`、真实 Electron/Computer Use 记录已写入状态账本。
- [x] 活动文档的目标模式状态和旧版本派工权已同步。
- [x] 阶段 0 独立复审达到 P0=0、P1=0；P2=4 已记录于 [`0.4.0-STAGE-0-INDEPENDENT-REVIEW.md`](0.4.0-STAGE-0-INDEPENDENT-REVIEW.md)。
