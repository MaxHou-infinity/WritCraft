# WritCraft 日常写作工作区 V1 合同

> 合同版本：`writcraft.daily-workspace/v1`  
> 对应产品版本：`0.2.0`  
> 状态：候选验收完成；尚未发布（2026-08-03）

本合同定义 0.2.0 项目首页、当前章节大纲、`⌘P` 快速打开和可恢复导航的共同数据、定位、状态与失败边界。它不新增 AI 调用、正文写入权限、跨重启 Diff 或章节完成度判断。

## 1. 产品信息架构

1. 左侧常驻功能栏新增“项目首页”入口；项目首页属于中间主工作区，不占用右侧 AI 面板。
2. 已有项目默认恢复上次写作位置；新项目或作者主动点击入口时显示项目首页。
3. 项目首页、大纲和 `⌘P` 都消费 Main 的同一份项目 inventory、标题索引和定位服务，不在 Renderer 扫描项目或复制权威状态。
4. `⌘P` 只快速定位当前项目的文件、标题、Graph 实体/问题和当前会话待审修改；`⌘⇧F` 继续负责正文全文搜索。
5. 所有卡片和结果必须能执行真实跳转；统计不能成为无目标装饰。

## 2. 权限与进程边界

- Main 拥有项目根、文件清单、内容 revision、索引 generation、Graph、Sources、pending ChangeSet、workspace 持久化和 locator 解析权。
- Renderer 只提交查询、选择和导航意图。它不得以 `window.__workspace.state`、Changes DOM、Graph/Sources 缓存或未保存编辑器文本计算项目权威统计。
- 工作区聚合对作者项目内容只读：零 AI、零网络、零正文/`edit.md`/来源写入。Main 可以沿用既有边界，在 `.writcraft` 内写入可再生 Graph 缓存和 issue-state 修复；这类私有派生写入失败只能使对应区块 unavailable/partial，不得阻止编辑或改变作者文件。Changes 的接受、拒绝与写入继续走既有 capability、Diff 和 History 边界。
- 未保存正文可单独标记为“当前文件有未保存内容”，但不得混入 Main 已保存字数和索引。

## 3. Main 权威快照

新增独立的 `project-home-snapshot-service`，以一次冻结的项目 inventory/content generation 产生有界快照。建议公开形态：

```js
{
  schema: 'writcraft.project-home/v1',
  projectInstanceId,
  authority: {
    projectMutationGeneration,
    inventoryGeneration,
    graphGeneration,
    sourceGeneration,
    pendingGeneration
  },
  status: 'ready' | 'partial' | 'blocked',
  generatedAt,
  summary: { markdownFileCount, manuscriptFileCount, manuscriptWordCount },
  continueLocation,
  recentFiles,
  chapterStates,
  pendingReviews,
  openIssues,
  explicitSourceGaps,
  partialReasons: []
}
```

### 3.1 生产 envelope

- 完整 snapshot 序列化后最多 2 MiB；每个用户可见字符串最多 1,024 UTF-8 bytes，路径最多 4,096 UTF-8 bytes。
- `recentFiles <= 8`、`chapterStates <= 1,000`、`pendingReviews <= 10`、`openIssues <= 500`、`explicitSourceGaps <= 500`、`partialReasons <= 64`；同一 reason code 去重。
- 先保留 summary/continueLocation，再按最近修改章节、pending、open issue、source gap 的顺序填充。任一数组或总字节达到上限时停止追加该类，返回 `completeness: 'truncated'` 及 `*_LIMIT` reason；不得在截断后继续拼接再裁字符串。
- inventory 超过既有安全树上限、无法建立最小 summary 或响应头本身超限时 `blocked`；卡片数据超限则 `partial`，不得阻塞编辑器。
- 边界测试必须覆盖每数组恰好上限、上限 +1、最大 UTF-8 字段、总响应恰好 2 MiB 和 +1 byte；所有拒绝/截断均为零作者文件写入、零 AI/网络。

### 3.2 确定性数据来源

| 信息 | Main 权威来源 | 冻结语义 |
|---|---|---|
| Markdown 清单 | `projectService.listTree()` | 只含公开、非 symlink、项目内 Markdown；`.writcraft` 永不计入 |
| 内容与 revision | `readFileWithRevision()` | 同一 generation 内读取；漂移则整项失效或进入 partial |
| 标题/大纲 | `shared/context-selection.parseMarkdownSections()` | 支持 ATX/Setext，排除 front matter 与 fenced code；重复标题由 occurrence/sectionId 区分 |
| 继续写作 | Main workspace | 使用 activePath、caret、scroll；不是“最近编辑”推断 |
| 最近文件 | 新 Main snapshot 采集文件 `mtimeMs` | 仅表述“最近修改”，按 `mtimeMs DESC, normalized path ASC` 稳定排序，最多 8 个；mtime 缺失或越界时排除该项并返回 `FILE_TIME_UNAVAILABLE` partial reason，不从 Renderer 补值 |
| 待审修改 | Main pending ChangeSet store | 只列当前会话、当前项目仍有效对象；重启后为空 |
| 未解决问题 | Graph index + issue state | 仅 `status === 'open'`；acknowledged 不冒充 open |
| 来源缺口 | open 的 Graph `evidence_gap` | 只来自正文显式 `[待补来源]`/citation-needed 标记，不由模型猜测 |
| Sources 状态 | `source-index-service` | ready/partial/empty 与底层 reason code；不推断论点质量 |

### 3.3 正文范围与字数

- `markdownFileCount` 含 `edit.md`、references/、sources/ 等全部公开 Markdown。
- `manuscriptFileCount` 与 `manuscriptWordCount` 排除 `edit.md`、`references/`、`sources/`、隐藏目录；仅统计其余公开 Markdown。
- 字数算法：先去除 YAML front matter、HTML 注释和 Markdown 结构标记；fenced/inline code 保留代码正文；链接保留可见文字、丢弃 URL；图片保留 alt、丢弃 URL；表格保留单元格文字、丢弃分隔行；脚注定义与引用的可见文字各按正文计；HTML entity 解码后计数；反斜杠转义按转义后的字符计。连续 CJK 与全角数字逐字符计 1，连续拉丁字母/半角数字及其内部 apostrophe/hyphen 计 1，emoji 按一个 Unicode grapheme 计 1，组合附加符不单计，独立标点与空白计 0。实现进入 `src/shared/`，上述每类至少一个黄金 fixture，并固定整篇总数。
- 章节文件不是根据目录名猜测；0.2.0 将 manuscript Markdown 的每个文件作为一个可导航“章节条目”，显示真实路径。未来书籍层级另立合同。

### 3.4 章节状态

基础状态三选一，附加状态可叠加：

- `blank`：去除 front matter、HTML 注释和空白后为空。
- `skeleton`：剩余内容只有 Markdown 标题、空列表项、空引用或 TODO 占位；fenced code 中的非空内容视为正文。
- `body`：存在至少一个非空正文、列表、引用、表格或 fenced code 内容。
- 附加 `pending_review`：当前会话 pending ChangeSet 指向该路径。
- 附加 `open_issue` / `source_gap`：当前 Graph open issue 的权威 evidence 指向该路径。

禁止生成 `completed` 或按字数推断完成度。

### 3.5 卡片状态与动作

项目首页顶层只允许 `ready | partial | blocked`。每一区块返回两组正交状态，禁止 Renderer 通过数组或文案猜测：

- `dataStatus: 'ready' | 'empty' | 'unavailable'`；
- `completeness: 'complete' | 'partial' | 'truncated' | 'session_only'`。

每一区块同时携带有界 `reasonCodes`。例如 Sources 的既有 ready/partial/empty 映射为 `dataStatus` 与 `completeness`，而当前会话待审区块即使非空也必须标记 `session_only`。

| 区块 | 空状态 | 主要动作 |
|---|---|---|
| 继续写作 | 没有有效 workspace 位置 | 打开 `edit.md`，否则首个 public Markdown，再否则文件树 |
| 项目摘要 | 0 个正文文件 | 展开按文件统计/打开文件树 |
| 最近修改 | 没有正文文件 | 打开文件树 |
| 待审修改 | 当前会话无 pending：`empty/session_only`，无主要动作 | 非空时打开仍有效 inline Diff；expired/evicted 时刷新为 `REVIEW_NOT_AVAILABLE` 并禁止跳转 |
| 问题 | 无 open issue | 通过 Main locator 定位 Graph 问题或原文依据 |
| 来源缺口 | 无显式 open gap | 定位显式缺口；不自动进入 Research |
| 章节 | 空项目 | 打开文件树或创建文件 |

## 4. 共享 Workspace Location V1

大纲、`⌘P`、Graph、Sources、首页和 pending review 共用两阶段 Main 协议：列表只展示，激活时重新解析。

```js
listWorkspaceLocations(projectInstanceId, { query, kinds, limit, requestId })
// -> { schema, projectInstanceId, authority, status, partialReasons, items }

resolveWorkspaceLocation(projectInstanceId, locationId)
// -> { schema, projectInstanceId, authority, kind, target }
```

当前文稿大纲使用同一 inventory、同一会话 locationId 和同一 resolve 边界，但采用独立的只读投影，避免 Renderer 从展示文案推断标题层级或位置：

```js
listCurrentOutline(projectInstanceId, { path, requestId })
// -> {
//   schema: 'writcraft.document-outline/v1', projectInstanceId, authority,
//   path, revision, status, partialReasons,
//   items: [{ outlineId, locationId, label, level, parentOutlineId,
//             occurrence, startOffset, endOffset }]
// }
```

`path` 只是 Main 当前 inventory 的精确查找键，不是文件系统权限；文件不存在稳定失败 `LOCATION_MISSING`。`outlineId` 等于当前 revision 下的 `sectionId`，只用于折叠与高亮，写入或外部变化后必须重新读取；激活仍只提交不透明 `locationId` 并由 Main 重解。大纲最多 1,000 项、完整响应最多 512 KiB；先按文稿顺序装入完整条目，达到任一上限即停止并返回 `partial + LOCATION_RESULTS_LIMIT`，不得裁剪字符串或让 Renderer 补扫正文。

查询字符串最多 256 UTF-8 bytes，`kinds <= 5` 且只能取冻结枚举，`1 <= limit <= 100`，items 最多 100，单次响应最多 512 KiB。超过查询/参数边界稳定失败 `INVALID_QUERY`；结果达到 item/bytes 上限返回 partial + `LOCATION_RESULTS_LIMIT`。构建索引最多读取既有 project tree 允许的 5,000 entries，但工作区索引仅接受 public Markdown，并受 5 秒和 2 MiB snapshot envelope 约束。

列表 item 只含 `{locationId, kind, label, detail, breadcrumb, badges}`，不得包含 rootPath、正文 quote、真实 ChangeSet capability 或可伪造 offset。

Stage B 为 pending store 增加 Main-only public projection：`listPublicReviewLocations(projectInstanceId)` 最多返回当前项目仍有效的 `{locationId, label, targetPaths, fileCount, hunkCount, expiresAt}`。`locationId` 是当前进程内随机、不透明、项目绑定且至多与内部 capability 同寿命的映射；真实 capability 永不进入列表、Renderer state 或 workspace 持久化。接受、拒绝、过期、淘汰或项目切换必须同时销毁映射；后续 resolve 只能返回 `REVIEW_NOT_AVAILABLE`，不得从 History、Renderer 或旧 projection 重建审阅。

非 pending 位置另有可持久化的 `stableLocator`，只允许以下确定性描述：file `{kind,path}`、heading `{kind,path,sectionId}`、entity `{kind,nodeId}`、issue `{kind,issueId}`。`path` 最多 4,096 UTF-8 bytes；`sectionId` 必须匹配 `^sec_[0-9a-f]{16}$`，`nodeId` 匹配 `^node_[0-9a-f]{16}$`，`issueId` 匹配 `^issue_[0-9a-f]{16}$`；单个 locator JSON 最多 8 KiB。Main 保存前验证 exact keys、项目内路径和字段边界，并在当前 project authority 下重新签发会话 `locationId`；stableLocator 不含 generation、offset、quote、revision、rootPath 或 capability。伪造、跨项目、未知 kind/字段、重启后无法重解分别失败 `INVALID_LOCATION`、`PROJECT_CHANGED` 或 `LOCATION_UNRESOLVED`。pending review 没有 stableLocator，永不进入持久化 returnStack。

激活规则：

- `file`：Main 返回当前 filePath/revision 和起始位置。
- `heading`：按当前 revision 重新解析 `path + normalized heading + occurrence/sectionId`；重复标题显示路径、层级 breadcrumb 和同名序号。
- `entity` / `issue`：Main 重新索引/reconcile 并选择仍有效的 evidence；Renderer 禁止用 `content.indexOf(quote)` 猜位置。
- `pending_review`：Main 只返回公开 review location，内部映射到仍有效 capability 并进入既有 inline review。
- Renderer 打开文件后若 revision 已漂移，只能回 Main 有界重解一次；仍漂移则失败，不做本地修复。

### 4.1 待审 Diff 的无 capability 恢复

Stage D 为 `pending_review` 增加三条窄桥，Renderer 始终只持有公开 `reviewLocationId`：

- `hydratePendingReview(projectInstanceId, reviewLocationId)`：Main 重新验证项目、根目录、有效期和公开映射，再返回可展示 review；返回 review 的公开 `changeSetId` 必须等于 `reviewLocationId`，不得返回内部 capability。
- `applyPendingReview(projectInstanceId, reviewLocationId, decision)`：Main 从仍有效映射取回内部 capability，拒绝 Renderer 传入其他 review 身份，再复用既有 Changes/History 事务。
- `discardPendingReview(projectInstanceId, reviewLocationId)`：Main 解析并终结对应内部 capability，同时销毁公开映射。

hydration 只恢复当前进程、当前项目仍有效的审阅，不从 History 或磁盘重建。项目切换、过期、已接受、已拒绝、已丢弃或 public projection 淘汰后统一失败 `REVIEW_NOT_AVAILABLE`。Renderer 只能在 hydration 成功后公开首页/`⌘P` 待审入口；普通 Changes 新生成流程继续使用既有内部会话能力，不改变 0.1.2 写入安全边界。

稳定调用失败：`NO_PROJECT`、`PROJECT_CHANGED`、`PROJECT_MUTATION_IN_PROGRESS`、`PROJECT_WATCHER_UNAVAILABLE`、`HOME_SNAPSHOT_TIMEOUT`、`LOCATION_MISSING`、`LOCATION_AMBIGUOUS`、`LOCATION_STALE`、`LOCATION_UNRESOLVED`、`REVIEW_NOT_AVAILABLE`。`INDEX_BUILDING`、`PARTIAL_RESULTS`、`INDEX_LIMIT`、`GRAPH_UNAVAILABLE` 属于成功返回的 `partialReasons`，不得当作整次调用异常。

## 5. 大纲与 `⌘P` 状态合同

### 5.1 当前章节大纲

- 只展示当前 Markdown 文件的标题树；点击通过共享 locator 定位。
- 滚动高亮使用当前 revision 下已解析 offsets；revision 变化后失效并重建。
- 支持折叠、键盘和窄窗口；不支持拖动、重排或任何写入。
- Stage C 在当前会话保留折叠 sectionId；Stage E 完成下述 workspace/v2 迁移后，才持久化 `activeOutlineId` 与折叠 sectionId。不得把新字段静默写入 workspace/v1；失效项逐项丢弃，不影响文件恢复。

### 5.2 快速打开

状态机：`closed -> querying -> ready | empty | partial | error`。

- 每次输入带递增 requestId；迟到结果和旧项目结果丢弃。
- 每次按键只查 Main 内存索引，不重新全树读文件。全文搜索保留原入口，只共享 inventory/read 层。
- Stage C 结果按 file、heading、entity、issue 分组；Graph 未就绪时先返回文件/标题 partial。Main 已支持 pending_review 的公开列举与失效解析，但真正的无 capability 审阅恢复必须随 Stage D 项目首页一起交付；在此之前 Renderer 不得列出一个无法恢复的待审项，也不得把 Main“仍有效”误报为 UI“已过期”。
- `⌘P` 聚焦输入；ArrowUp/Down、Home/End、Enter、Esc 完整可用。IME composition 中不提交查询或重建 input；更新结果保持节点身份、焦点、选区与 active descendant。
- 项目切换关闭入口并取消旧 owner；空结果 Enter 无动作。

## 6. Workspace V2 与返回路径

`writcraft.workspace/v2` 在 v1 的 tabs、activePath、cursorOffset、scrollTop 上增加：

```js
files[path] = {
  caretOffset,
  selectionAnchorOffset,
  selectionFocusOffset,
  scrollTop,
  activeOutlineId,
  collapsedOutlineIds
};
returnStack = [{
  view,
  stableLocator: null | stableLocator,
  scrollTop,
  editorReturnState: null | {
    path,
    caretOffset,
    selectionAnchorOffset,
    selectionFocusOffset,
    scrollTop,
    revision
  }
}];
```

`activeOutlineId` 只能为 `null` 或匹配 `^sec_[0-9a-f]{16}$`；`collapsedOutlineIds` 最多 128 项，每项同一格式、去重并按文档顺序保存。workspace/v2 继续受既有 100 tabs 与 256 KiB 总包络约束，达到任一边界即稳定拒绝，不静默裁掉当前文件状态。

- offset 均为 UTF-16 非负安全整数；恢复时按当前文档长度 clamp。内容/revision 漂移只降级到安全位置，不伪造旧选区。
- v1 迁移保留 tabs/current/cursor/scroll，选区折叠到 cursor，returnStack 为空。
- 单个路径失效只剔除该项；active 失效时选择最近合法 tab，再 `edit.md`、首个 Markdown、文件树。未知未来 schema 或损坏 JSON 不覆盖原文件，并返回可诊断降级。
- `view` 只能是 `project_home | editor | graph | sources | changes`，最多 32 UTF-8 bytes。纯视图位置使用 `stableLocator: null` 并只恢复该视图和 scrollTop，不持久化未列入 schema 的筛选器/UI 状态；具体文件、标题、实体或问题使用对应 stableLocator。Sources 0.2.0 只恢复 Sources 视图，不持久化单个来源身份；Graph 只有定位到具体实体/问题时才持久化 locator。
- 深跳发生前若作者位于正文，栈项同时冻结 exact-key `editorReturnState`：path 最多 4,096 UTF-8 bytes，四个 offset/scroll 均为非负安全整数，revision 必须匹配 `^[0-9a-f]{64}$`，单项 JSON 最多 16 KiB。返回时 Main 先验证 path/revision；revision 相同则恢复原 caret、选区和 scroll，revision 漂移则清除选区、clamp caret/scroll 到当前安全位置并明确标记 `RETURN_POSITION_ADJUSTED`，不得依赖已被深跳覆盖的 `files[path]`。
- returnStack 最多 32 项，相邻去重；普通 tab 切换与 pending Changes 审阅不入持久化栈。当前会话可在内存返回栈保存 pending review 的临时 locationId，但退出/切项即丢弃。返回时 Main 对非空 stableLocator 重新签发/resolve，失效则继续弹出；空 locator 仅恢复 allowlist view，不产生文件权限。
- load/save 必须绑定 exact `projectInstanceId + operationGeneration`；Main 不匹配返回 `PROJECT_CHANGED`。切换项目先 await 当前 workspace save、取消旧 timer；旧 finally 不得写入或清理新项目。
- App 关闭采用可等待的 Main flush/close handshake；不得以 fire-and-forget `beforeunload` 作为耐久证据。

## 7. 刷新、并发与失败矩阵

快照在首次进入、显式重试、Main 成功文件事务及 watcher authoritative external change 后失效。读取前使用 Main-owned barrier：等待 in-flight watcher polling、强制有界快照、排空 pending changes，并绑定 project instance 与 mutation generation；不得用 debounce 或等待时间推断新鲜度。

快照 `authority` 是来源向量而不是一个总版本号。Main 在 barrier 后冻结 `projectMutationGeneration + inventoryGeneration`；Graph、Sources、pending store 分别记录独立 generation，不具备原生 generation 的来源由 snapshot service 在成功刷新或 store mutation 时递增。每一区块读取前后复核依赖向量：项目实例/项目 mutation 漂移使整份结果 blocked；inventory 漂移使 summary、recent、chapter 和 location 全部失效；graph/source/pending 单独漂移只使对应区块 unavailable/partial。已发布 item 携带其 authority 投影，resolve 始终按当前向量重解，旧投影不构成授权。

| 场景 | 终态 | 用户仍可执行 |
|---|---|---|
| 5 秒未完成 | `blocked/HOME_SNAPSHOT_TIMEOUT`，文案“项目统计暂不可用” | 继续编辑、重试统计、打开文件树 |
| 部分索引受限 | `partial` + 底层 reasonCodes | 使用已验证区块、重试 |
| Graph/Source 不可用 | 对应区块 unavailable，其余可用 | 打开正文/文件树、重试 |
| watcher/barrier 失败 | blocked 或 partial，禁止陈旧真相 | 继续编辑、手动重试 |
| 项目切换 | 丢弃旧结果 | 新项目独立加载 |
| retry | 新 owner | 旧 finally/迟到结果不得清新 owner |
| 文件删除/改名 | locator missing | 仅打开仍存在文件/文件树 |

聚合不得加入现有串行项目进入链阻塞编辑器。5 秒从 Main 接受 snapshot request 起算；timeout/cancel 为零作者文件写入、零 AI/网络，允许已启动的既有私有派生缓存事务自行按其合同收口；已验证 partial 可显示但逐区标明不完整。

## 8. 性能与真实 Electron 验证

### 8.1 固定基线

- 固定测试机：MacBook Pro（Mac17,2）、Apple M5 10 核、24 GB、arm64；macOS 26.5.1、Node 26.3.1、npm 11.16.0、Electron 43.2.0。fixture/profile 均位于内置 APFS SSD 的私有临时目录，运行前可用空间至少 20 GB；窗口必须可见且不被遮挡。每次证据另记 exact commit、显示刷新率、电源状态与后台负载，不记录序列号或设备标识。
- 窗口 1400×900、zoom=1；fixture 清单固定目录深度、标题、Graph/History/Sources/workspace 状态、随机种子与 manifest hash。
- 50/300 指全部 public Markdown 总数，包含 `edit.md`；修正旧 300 chapters + edit.md 实际 301 文件 fixture 的口径。
- 起点：路径确定后 Renderer 发出 open/openRecent IPC 的 monotonic mark；不计文件选择器。
- 终点：项目首页或恢复编辑区可见、`aria-busy=false`、真实文件已加载、文件树可操作，并在两个 rAF 后成功处理 focus/键盘 probe。
- 冷样本：每次复制同一 manifest fixture 到新目录，fresh profile，删除可再生索引缓存但保留合同指定 workspace/History/Sources 状态，每次新 App 进程；热样本：同 profile/fixture 完成一次无修改预热后退出并重启，不清 OS page cache。两类各至少 5 次，报告排序后的每次、median、nearest-rank p95（`ceil(0.95*n)`）和 max；5 次样本时 p95 等于 max，仍保留字段以便扩大样本。
- 门禁以冷样本最慢一次计算：50 文件 ≤1.5 秒，300 文件 ≤3 秒；热样本只作诊断。

### 8.2 必测反例

- 5 秒阻塞注入后出现三项恢复动作，编辑器仍可输入，迟到结果不覆盖 retry/新项目。
- 真实 App 重启恢复 tabs/current/caret/selection/scroll；v1→v2、损坏状态和失效路径安全降级。
- 旧项目迟到 load/save、250ms timer 与 close flush 不污染新项目。
- 300 文件只建立一次索引，逐键查询不读全树；外部新增/修改/删除只使相关 generation 失效。
- 重复标题、长中文标题、深层标题、IME、键盘和窄窗口通过真实 Electron。
- 阶段 E 用测试专用 Main 通道调用 `webContents.setZoomFactor(2)` 并断言实际值为 2；不能用 deviceScaleFactor 代替。
- Graph 键盘/wheel/drag 分别采集非空 event→双帧 paint latency；明确断言样本数大于 0，不能让空数组自通过。

## 9. 实施顺序与退出条件

1. 阶段 B：共享 inventory/title index、project-home snapshot、public pending summary 与 list/resolve locator 窄桥。
2. 阶段 C（已关闭）：大纲与 `⌘P` 最小纵切，共用索引和 locator；外部刷新、窄窗口、真实 IME 与 300 文件专项通过。
3. 阶段 D（已关闭）：项目首页与所有卡片深跳转；pending review 使用无 capability hydration。
4. 阶段 E（已关闭）：workspace/v2、returnStack、close flush、性能、真实 zoom 和降级体验。
5. 阶段 F（已关闭）：pending 动态矩阵、Computer Use 真实作者客观旅程、完整回归、候选复审和所有者一次最短主观体验均已完成；P0=0、P1=0。0.2.0 候选验收完成，发布仍需单独授权。

阶段 A 退出要求：本合同与路线图/状态账本一致；独立复审 P0/P1=0；不存在未定义的数据来源、卡片动作、失败终态、locator 或性能计时口径。阶段 A 不制作假数据 UI。
