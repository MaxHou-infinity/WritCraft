# 笔触 · WritCraft — Phase A 项目工作区实施规格

> 版本：v1.0  
> 日期：2026-07-15  
> 状态：Phase A 工程权威规格  
> 产品依据：`docs/WRITCRAFT-PRD-V3.md`  
> 范围：把现有单文档 Electron 原型升级为安全、可恢复的本地多文件项目工作区。

> **历史工程交接（2026-07-29，0.0AC npm Developer Preview 本地签字收口）**：0.0AC 新增 macOS CLI、窄 npm 包、Node `>=22.12.0`、npm 10/11 fail-closed、Electron `43.2.0`、Main 观测 `did-finish-load` 后的 CLI readiness IPC 和零网络 `--check`；同时让 `sk-cp-` 图片能力进入 provider 现场门禁。该 readiness 只证明页面加载完成，不单独证明全部 workspace/bootstrap 逻辑成功。该批历史证据为 Persistent **3/3**、npm Preview **10/10**、installed **2/2**、真实 Electron **35/35**；当前候选只看下条。
> **下一阶段合同**：`docs/AUTHOR-ACCEPTANCE-V1-CONTRACT.md` 已冻结，明确付费网络门禁、允许记录的隐私安全证据、真实长文旅程与发布前签字顺序。
> **当前实现停点**：`writ-craft@0.1.1` 已公开到 npm `preview`，`latest` 仍为 `0.1.0`；唯一目标仍是 `RM-1.0 / 0.1.2` 真实作者闭环。项目卡、Inline 与 Chapter 已完成。0.0BW candidate `c6d8c44` 关闭 Plan 输出容量后，真实 operation `b915291982d14f8bb5520674280b3d0d` 在 13,590 ms 暴露首任务 `dependsOn` 被填入自然语言；before/after 0，项目零写入。0.0BX 将 ID/依赖统一为不 trim 的精确短 ASCII ID，在 Schema 内补字段说明和唯一性，并让依赖结构错误共享既有一次重试预算；第二次失败终止、绝不第三次调用。Plan 26/26、handoff 15/15、UI 16/16、完整 test/verify 与强制真实 Electron 37/37 通过，独立终审 P0/P1/P2=0。Exact candidate `1c7f178` 已重启，只待一次新 provider canary。默认模型仍为 MiniMax-M3，显式 8 文件/240 KiB 上下文门禁不变。0.1.2 尚未发布；精确红绿只看 `v0/DEVELOPMENT-STATUS.md`。
> **路线图入口**：Phase A 已是工程地基，不再负责后续版本排期。当前唯一目标是 `docs/ROADMAP.md` 的 `RM-1.0 / writ-craft@0.1.2` 真实作者可用性闭环。

## 1. 阶段目标

Phase A 只建立后续跨文件 AI 和一致性星图所需的可靠地基：

- 本地项目创建、打开与恢复；
- 根目录 `edit.md` 生成、编辑和加载；
- 左侧项目文件树和中央多文件切换；
- Markdown 文件读取与原子保存；
- 明确的 main / preload / renderer 安全边界；
- 从现有 localStorage 单文档草稿迁移；
- 为后续索引、图谱和 ChangeSet 预留稳定的项目元数据。

Phase A 不实现完整语义检索、跨文件自动修改或图谱抽取，但数据与 IPC 设计不能阻断这些能力。

## 2. 项目目录契约

推荐的新项目初始结构：

```text
my-writing-project/
├── edit.md
├── outline.md                 # 可选；用户确认后创建
├── chapters/                  # 可选；用户确认后创建
├── references/                # 可选来源文件
├── assets/                    # 图片和附件
└── .writcraft/
    ├── project.json           # 项目标识与 schema 版本
    ├── workspace.json         # 标签、活动文件、布局等可恢复状态
    ├── index.json             # Phase B 起的派生索引
    ├── graph.json             # Phase C 起的派生图谱
    ├── issues.json            # 问题及用户处置状态
    ├── changes.json           # AI ChangeSet 审计与安全撤销记录
    └── recovery/              # 未落盘恢复稿，不作为正文真相来源
```

### 2.1 文件职责

- 正文和项目规则使用 Markdown，是用户拥有的权威内容。
- `.writcraft/project.json` 必须包含稳定 `projectId`、`schemaVersion`、`createdAt`、`updatedAt`；不得包含 API Key。
- `workspace.json` 是可丢弃的 UI 状态，不得成为找回正文的唯一途径。
- `index.json`、`graph.json` 可重建；其损坏不得阻止打开正文。
- `issues.json` 同时保存用户确认、忽略和解决状态，重建图谱时需要迁移这些决定。
- 所有持久化路径使用项目根目录相对 POSIX 路径；不得把开发机绝对路径写入项目元数据。

### 2.2 支持范围

Phase A 可编辑 `.md` 和 `.markdown`，读取时接受 UTF-8（含 BOM），保存统一为 UTF-8。其他文件在树中可显示但默认不可编辑。`.writcraft` 默认不在普通文件树展示，通过设置允许查看。

## 3. 进程边界

Electron 必须保持 `contextIsolation: true`、renderer sandbox 开启、`nodeIntegration: false`。renderer 不得直接访问 Node `fs`、`path`、`process` 或 Electron 主进程对象。

### 3.1 Main 进程

Main 是唯一有权访问文件系统和系统对话框的边界，负责：

- 创建/打开/关闭项目和维护 project session；
- 路径解析、canonicalization、权限和扩展名校验；
- 目录枚举、文件读取、原子保存、重命名、移动和安全删除；
- 监听外部文件变化并生成冲突事件；
- 项目元数据与恢复稿持久化；
- 现有 MiniMax 网络请求及密钥管理；
- 返回结构化错误，不向 renderer 暴露堆栈、密钥或任意主机路径。

Main 不负责 DOM、标签页显示、编辑器 Selection 或 Diff 渲染。

### 3.2 Preload

Preload 仅通过 `contextBridge` 暴露窄接口。建议按域组织：

```js
window.writcraft = {
  project: {
    create(), open(), getCurrent(), close(), onChanged(handler)
  },
  files: {
    list(), read(relativePath), save(relativePath, content, expectedRevision),
    create(relativePath, content), rename(from, to), move(from, to), trash(path),
    onExternalChange(handler)
  },
  workspace: {
    load(), save(state), writeRecovery(entry), clearRecovery(entryId)
  },
  ai: {
    rewrite(payload), chat(payload), check()
  }
}
```

接口只能接收和返回可结构化克隆的数据。事件订阅函数必须返回 unsubscribe；preload 自己持有原始 IPC listener，避免 renderer 能移除其他监听器。禁止提供任意 channel 的 `send` / `invoke` 通道。

### 3.3 Renderer

Renderer 负责：

- 活动栏、文件树、标签页、编辑器、AI 面板和状态栏；
- 一个主工作区路由统一拥有文件、搜索、来源和图谱的可见性、活动态与侧栏生命周期；功能 Renderer 只响应 `activate/deactivate`，不得竞争同一导航点击；
- 每个打开文件的内存 buffer、dirty 状态、光标与滚动状态；
- debounce 自动保存调度，但不直接写磁盘；
- 呈现保存错误、外部冲突和迁移预览；
- 组装显式 AI 作用域，调用 preload 中的领域接口；
- 保留现有段落级 Inline Diff 的用户体验。

Renderer 不得根据一个绝对路径自行判断是否安全；路径安全必须由 Main 最终执行。

## 4. IPC 数据契约

所有 IPC 返回统一结果：

```ts
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; recoverable: boolean } };
```

文件读取返回：

```ts
type FileSnapshot = {
  relativePath: string;
  content: string;
  revision: string;       // 内容哈希或 stat + hash 的不透明令牌
  mtimeMs: number;
  size: number;
};
```

保存请求必须携带最近读取或成功保存得到的 `expectedRevision`。若磁盘 revision 不匹配，Main 返回 `FILE_CONFLICT`，不得覆盖。仅首次创建文件允许显式 `expectedRevision: null`，并使用 exclusive create。

建议错误码：`NO_PROJECT`、`INVALID_PATH`、`PATH_OUTSIDE_PROJECT`、`UNSUPPORTED_FILE`、`NOT_FOUND`、`ALREADY_EXISTS`、`FILE_CONFLICT`、`WRITE_FAILED`、`PERMISSION_DENIED`、`PROJECT_CORRUPT`。

## 5. 路径安全

路径输入一律视为不可信，即使来自 renderer 自己生成的文件树。

### 5.1 解析规则

每个文件操作必须：

1. 拒绝空路径、NUL、URL、盘符式路径、绝对路径和 `..` 路径段。
2. 将分隔符规范化后解析为项目相对路径。
3. `resolve(projectRoot, relativePath)` 后验证结果位于 canonical project root 内。
4. 逐段检查符号链接；V0 默认拒绝任何解析后逃出项目根目录的 symlink。
5. 对已有文件比较 `realpath`；对新文件比较最近存在父目录的 `realpath`。
6. 按操作校验扩展名、大小和特殊目录规则。

简单字符串 `startsWith(projectRoot)` 不足以证明安全，因为 `/project-other`、大小写和 symlink 都可能绕过。

### 5.2 保留路径

- renderer 不得直接修改 `.writcraft/project.json`、`graph.json` 等内部文件。
- `edit.md` 可通过正文编辑接口读写，但仍受 revision 与原子保存保护。
- 临时文件名使用应用生成的随机后缀；拒绝用户创建与内部临时命名冲突的路径。
- 删除默认进入系统废纸篓；若系统废纸篓调用失败，Phase A 返回错误，不降级为永久删除。

## 6. 原子保存与恢复

### 6.1 原子保存流程

保存单个文件时 Main 执行：

1. 验证项目 session、路径和 `expectedRevision`。
2. 在目标文件同一目录创建唯一临时文件，例如 `.filename.writcraft-<nonce>.tmp`，使用 exclusive create。
3. 写入完整 UTF-8 内容并 `fsync` 临时文件。
4. 保留合理的原文件权限；不复制扩展属性不是 Phase A 阻塞项，但需记录限制。
5. 再次校验目标 revision，避免写入窗口内的外部覆盖。
6. 在同一文件系统内 rename 临时文件到目标路径。
7. 在支持的平台 `fsync` 父目录。
8. 返回新的 revision、mtime 和 size。
9. 任一步失败时清理本次临时文件；原文件必须保持可读。

不能用“先删除旧文件再写新文件”，也不能将磁盘保存成功建立在 localStorage 成功之上。

### 6.2 自动保存状态机

```text
clean → dirty → saving → clean
                  ├── save-error → dirty
                  └── conflict → dirty + blocked
```

- 编辑后 debounce 保存；切换标签不强制丢弃未保存 buffer。
- 同一文件同一时刻只允许一个保存请求；保存期间的新编辑排队为下一 revision。
- 窗口关闭前等待短时间内的在途保存；仍失败时展示“重试 / 保留恢复稿 / 取消关闭”。
- UI 只有收到 Main 成功结果后才能显示“已保存”。

### 6.3 恢复稿

- dirty buffer 定期写入 `.writcraft/recovery/`，记录项目 ID、相对路径、基准 revision 和时间。
- 正常保存后清除对应恢复稿。
- 启动发现恢复稿时比较磁盘 revision，展示 Diff 后由用户恢复或丢弃。
- 恢复稿不能自动覆盖磁盘文件，也不能当作已保存状态。

## 7. 项目与工作区状态

### 7.1 项目 Session

Main 为当前窗口保存不可伪造的 project session，不允许 renderer 在每次调用时提交任意 root。所有文件 IPC 都基于该 session 的 canonical root。

同一窗口 Phase A 只打开一个项目；未来多窗口项目可以各自持有 session。切换项目前必须处理 dirty buffer。

### 7.2 文件树

- 默认忽略 `.git`、`node_modules`、`.DS_Store` 和应用临时文件。
- 目录枚举设置文件数、深度和单文件大小保护；超限时局部折叠并提示，不让 renderer 卡死。
- 树节点使用相对路径作为身份，显示名仅用于 UI。
- 外部新增、修改、重命名或删除通过 Main watcher 转成结构化事件；watcher 事件只是失效信号，renderer 应重新读取权威快照。
- 在 watcher 驱动的状态之后生成新 AI capability 时，Renderer 的队列排空或时间稳定窗都不能充当权威证明。必须由 Main 等待在途 poll、强制新快照并清空 pending 后签发绑定当前项目实例与 mutation generation 的一次性 flush barrier；任何扫描不完整、项目切换或 watcher degraded 均 fail-closed。
- strict flush 的 Markdown hash 必须以扫描时私有 BigInt identity 绑定祖先链和叶子。生产路径从已绑定项目根 fd 交给 native helper，逐段 `openat(O_DIRECTORY|O_NOFOLLOW)` 并在下降前验证每级目录；叶子在读前/读后验证，返回成功前再从根重走整条链。最终组件或祖先替换、symlink、增长、原地改写、预算/协议/helper 故障均使覆盖不完整；公开 snapshot 仍保持既有 Number `size/mtimeMs` 兼容语义。该合同不证明初始项目根路径打开时的上层祖先，也不让 readdir/fs.watch 与外部写入变成原子操作。
- **0.0X 根链绑定合同（已实现并通过全链验证）**：Main 在启动 worker 前记录用户所选 canonical project root 的私有 `{dev, ino, mode}`，但不再 `open(rootPath)`；只把可信文件系统根 `/` 的只读目录 fd 作为 fd 3 交给 helper。绝对项目路径只允许以有界、十六进制、单次启动记录进入 helper stdin，禁止进入 Renderer、stdout/stderr、诊断、测试证据或错误文案。
- helper 必须从 fd 3 对绝对路径每个组件执行 `openat(O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)`，绑定并私存每级 `{dev, ino, mode}` 与最终项目根 fd；返回 Main 的启动 ACK 只含最终根身份。最终根与 Main 预捕获身份不一致时启动失败，不能把换壳后的目录采纳为原项目。
- 每个 hash batch 在读取任何稿件前和发出成功终态前都必须从可信 fd 3 重走完整外层链；任一级路径、symlink 或身份漂移都返回 batch-level `ROOT`，本批结果整体无效且不得签发 watcher authority。原链恢复后允许同一已绑定 worker 重试；协议/预算/helper 故障仍按既有规则终止 worker。
- 该合同关闭的是“身份捕获后到 native 绑定及后续 hash”之间的项目外祖先换壳，不把文件选择器之前的用户选择、`readdir/fs.watch` 非原子性、同 UID 已持有 fd 写入或 0.0U 已接受的 0700 reserve residual 宣称为关闭。验收必须包含绑定前外祖先替换红测、绑定后外祖先替换/恢复、路径零回显、真实 native、Main watcher、完整 test/verify、Persistent、真实 Electron、package/release 和独立复审。

### 7.3 标签页状态

`workspace.json` 保存：schema、活动相对路径、固定标签列表、每个文件的光标/滚动位置、面板尺寸和上次正常关闭时间。写入也应原子化，解析失败时使用默认布局并保留损坏文件用于诊断。

中央工作区的 Grid 高度链必须逐层使用 `min-height: 0` 和受限剩余高度，页面根保持不滚动；`.editor-scroll` 独占纵向滚动、保留可见 scrollbar gutter，`editor` 的最小高度相对该容器而不是 `100vh` 推算。真实 Electron 必须用超出一屏的长文证明 `scrollHeight > clientHeight`、`scrollTop` 可推进、body/document 保持 0，且底部状态栏仍在 viewport 内。

## 8. `edit.md` 加载与 AI 接入

- 创建项目时从 PRD V3 模板生成 `edit.md`，exclusive create 防止覆盖。
- 项目打开时读取并解析 Front Matter；解析失败不阻止编辑，但 AI 面板显示“项目规则格式错误”。
- 保存 `edit.md` 后使项目 Prompt cache 失效；下一 AI 请求读取已保存版本。
- renderer 发起 AI 请求时提交作用域和相对路径，不提交声称已验证的 `edit.md` 内容；Main 或受信任的上下文服务读取权威快照并组装。
- AI 响应记录本次使用的文件 revision 和 Context manifest，为后续 ChangeSet 冲突检测预留。
- Prompt 解析必须保留用户未知字段；不使用 YAML 反序列化结果执行代码或构造任意对象原型。

### 8.1 Onboarding v2 工程契约与当前停点

> 本节的 Renderer 31/31 与强制真实 Electron 20/20 是 Onboarding 的**历史专项签字证据**，不是当前项目总链；生产 Handler 11/11、Main/preload 14/14、Node/verify 与强制 Electron 28/28 也是 Graph 韧性修改前的最近完整基线。Renderer、fixture/API/Electron 与 Main single-flight/lifecycle 独立复审均为 P0/P1/P2=0。当前源码 Graph 复跑边界见文首；Onboarding 人工体验仍不能替代真实 API、真实作者或发布验收。

- 模型输出采用 strict exact-key schema，只允许 `summary`、固定 QUESTION_ID 对应的 `sections` 与最多 12 条 `fileSuggestions(path/title/reason)`；必须同时验证 `end_turn`、字符数和 UTF-8 字节上限，不接受 JSON 修复、围栏、外围文本或文件正文。
- 模型 Prompt 必须逐项声明 `fileSuggestions.path` 的生产禁区：`edit.md` 大小写变体、隐藏路径、`.writcraft/**`、`references/**`、`sources/**`、绝对路径和已有路径；没有安全建议时返回空数组。Main 的独立校验仍是最终权威，Prompt 约束不能替代 fail-closed。
- Main 是 `edit.md` 合并与初始文件模板的唯一权威：按固定章节映射合并 `writcraft.edit/v1`，保留合法 Front Matter、未覆盖的用户内容和自定义章节；建议文件内容只能由 Main 生成空白 Markdown 模板。
- 文件建议必须拒绝 `edit.md`、`.writcraft/**`、`references/**`、`sources/**`、隐藏/绝对/重复/已有路径，并在模型返回后、授权前和应用时复核项目 instance 与目标 revision。
- 有实际 `edit.md` Diff 时，只有绑定精确提案的一次性 capability 被完整应用后才能继续创建文件；no-op 使用独立 onboarding token。拒绝、丢弃、residual、过期、项目切换或 revision 变化均使授权失效。
- 用户查看最终 Diff 和文件清单后必须二次确认。批量创建先全量预检，再暂存和提交；任一失败都回滚为零个用户可见的新文件，不沿用旧 v1 的部分创建续跑语义。
- Renderer 只展示能够证明的进度：请求已提交、AI 整理与 Main 安全检查正在进行、成功后进入 Changes，并按秒显示等待时间；不把定时轮播文案冒充模型内部阶段。失败按稳定错误码映射为作者可执行说明，明确磁盘零修改与本页回答保留，不回显 JSON、内部路径分类或 Main 技术消息，也不把内存态保留误称为持久化保存。
- Changes Renderer 必须把审阅选择与磁盘提交分成两个明确阶段：接受/拒绝只更新 ID-only decision，底部显式确认才进入 Main apply。单 hunk 不重复渲染文件级批量按钮；已决定 hunk 默认收起为“尚未写入”的摘要，并允许重新展开。长耗时生成必须替换旧预览、显示已等待时间，并只让实际发起者拥有忙碌文案；错误或 no-op 必须终止进度状态。
- 项目卡入口属于项目级 activity rail，必须常驻可发现；当前文件工具栏不得重复放置文字按钮。入口用 disabled/`aria-pressed` 表达不可用与打开状态，不能通过隐藏造成入口位置漂移。
- Onboarding confirmation 必须把通用 Changes 面板收敛成单任务页：标题标明“项目初始化 · 第 2 步”，展示 `edit.md` 已完成 → 文件创建由作者决定的两步关系，隐藏 compose/History/Metrics，并把状态与动作分行。存在建议时显示等权尺寸的“跳过文件创建 / 创建所选文件”；零建议时隐藏创建动作，只保留“完成项目卡”，同时释放同一一次性 confirmation token。

## 9. 现有原型迁移

当前原型的单文档正文存在 localStorage 中，迁移目标是不丢稿、可撤销、可解释。

### 9.1 迁移触发

- 仅在首次打开新版且检测到旧草稿时显示迁移卡片。
- 未打开项目时，提供“从旧草稿创建项目”或“稍后处理”。
- 已打开项目时，提供预览并建议保存为 `chapters/imported-draft.md`；若文件已存在，生成不冲突名称，不覆盖。

### 9.2 迁移步骤

1. 只读提取旧 localStorage 草稿及可识别元数据。
2. 对临时 Inline Diff 先恢复为原始可读文本；无法确定时同时展示原始 HTML 和文本预览，禁止自动接受 AI 建议。
3. 清理编辑器专用标记，转换为 Markdown；无法无损转换的结构使用普通文本并在预览中提示。
4. 用户确认目标文件后，通过 Main 的 exclusive create + 原子保存落盘。
5. 重新读取文件并校验内容哈希。
6. 标记迁移完成，但保留旧 localStorage 至少一个发布周期；用户可手动清除。

迁移取消、应用崩溃或保存失败都不能删除旧草稿。

### 9.3 `editor.md` 兼容迁移

若项目根存在 `editor.md` 且不存在 `edit.md`：

- 显示文件内容和目标路径预览；
- 用户确认后执行安全 rename；
- 若两者同时存在，绝不合并或覆盖，只提示用户选择哪个作为项目 Prompt；
- 内部新功能和文档只使用 `edit.md`。

## 10. 实施顺序

1. 建立 project/file IPC 结果类型、路径防护和单元测试。
2. 实现项目创建/打开、`edit.md` 模板和 `.writcraft/project.json`。
3. 实现文件枚举、读取、revision 冲突和原子保存。
4. 构建工作区骨架：活动栏、文件树、标签、状态栏，并接入真实文件。
5. 将现有编辑器 buffer、Inline Diff 和自动保存从 localStorage 接到项目文件服务。
6. 实现 workspace 恢复稿、外部变更冲突和关闭保护。
7. 实现旧草稿及 `editor.md` 迁移。
8. 把 `edit.md` 权威快照加入 AI 请求并展示 Context Chip。
9. 完成自动化、真实 Electron 验收和开发文档更新。

任何一步都不得以允许 renderer 直接访问 Node 文件系统来换取速度。

## 11. 测试策略

### 11.1 单元测试

- 路径穿越：`../`、绝对路径、编码分隔符、相似前缀、symlink 逃逸。
- 原子保存：成功、写失败、rename 失败、并发修改、临时文件清理。
- revision：相同内容、外部修改、保存期间再次编辑。
- `edit.md`：模板、未知字段、无效 Front Matter、旧名迁移冲突。
- localStorage 迁移：纯文本、富文本、残留 Diff、取消和重复迁移。

### 11.2 集成测试

- renderer → preload → IPC → 临时项目目录的完整读写链路。
- 创建项目后目录和文件契约正确。
- 两文件切换、dirty buffer、自动保存和重启恢复。
- 外部修改触发 `FILE_CONFLICT`，不会被自动保存覆盖。
- `edit.md` 更新后下一 AI 请求的 Context manifest revision 改变。

### 11.3 真实 Electron 行为测试

至少完成一次打包前真实运行验收：

1. 用系统对话框创建项目。
2. 编辑 `edit.md`，创建两个章节文件并分别输入内容。
3. 快速切换标签并重启，确认内容和位置恢复。
4. 用外部编辑器修改其中一个文件，确认 WritCraft 显示冲突且不覆盖。
5. 模拟保存失败，确认未保存内容和恢复稿仍在。
6. 发起 AI 对话，确认 `edit.md` Context Chip 与实际 revision 一致。

源码字符串检查只能作为补充，不能代替上述行为证据。

### 11.4 反返工开发门禁（强制）

2026-07-19 至 2026-07-22，项目建立链经历了“修 JSON 容错 → 修 Changes 提交语义 → 修部分创建 → 重构 Onboarding v2 → 补 Renderer 跨层缺口 → 重跑真实 Electron”的连续返工。根因不是单个解析 Bug，而是最初没有同时冻结**用户验收场景、权威写入边界、完整状态机、原子性和跨层签字标准**。后续 Research→Changes、Inline Rewrite、Plan 及任何新的 AI 写入链必须执行以下门禁。

#### 11.4.1 编码前必须冻结的五项契约

1. **用户旅程契约**：先用 Given / When / Then 写明用户操作、可见结果、磁盘是否变化、失败后保留什么以及如何恢复。至少包含成功、no-op、拒绝、重试、项目切换、revision 漂移和提交后刷新失败。
2. **权威与所有权**：明确模型、Main、Preload、Renderer 和磁盘各自允许持有什么、修改什么。模型只能返回有界建议；Main 是校验、capability、revision 和文件写入的唯一权威；Renderer 只表达用户意图和展示权威结果。
3. **状态机**：实现前列出全部状态和合法迁移，不得用按钮文案或多个布尔值隐式拼装流程。公共状态至少包括 idle、generating、reviewing、completed、failed、discarded、expired 和 project-switched；malformed-but-retained、applied、awaiting-confirmation、committed-with-refresh-warning 等链路特有状态按功能适用，并必须显式记录适用项与不适用理由。
4. **原子性与终态**：预先声明哪些写入必须 all-or-nothing，哪些提交后失败只能降级为 warning。磁盘一旦提交成功，后续 bookkeeping、文件树刷新或 UI 聚焦失败不得把事实改写成“未提交”，也不得允许重复确认。
5. **可撤销和可审计性**：任何正文、`edit.md`、来源或图谱驱动的 AI 修改都必须进入 ChangeSet/History；明确 capability 的创建、消费、失效和独立回收条件。

上述五项有一项未冻结时，禁止先写 Renderer 或用 JSON 修复、重试、文案补丁掩盖契约缺失。

#### 11.4.2 固定验证顺序

每条跨层功能必须按以下顺序签字，不得跳级；“自动化组件签字”和“人工产品签字”必须分开记录：

1. 编码前完成协议、权威边界、状态机、原子性和用户旅程的**独立契约审阅**；未通过不得进入 Renderer 实现；
2. 实现协议/schema 与 Main service 单元测试；
3. 实现 Main/preload IPC、revision、capability、失败注入和项目切换集成测试；
4. 实现 Renderer 状态机、迟到结果、destroy/deferred/rAF、焦点与多资源独立释放动态测试；
5. 完成一次与作者实现分离的**独立代码/实现复审**，先关闭架构和跨层缺口，再进入昂贵的全量验证；
6. 确认新增套件在 `test` / `verify` 主链中按设计出现，既不漏跑也不重复；
7. 运行完整 `npm test` 与 `npm run verify`；Electron 专项因 GUI 沙箱无法启动时，必须在允许的真实 Electron 环境重跑并单独标注环境边界；
8. 运行强制真实 Electron BrowserWindow + 真实磁盘行为测试；到此只能签“自动化产品链”；
9. 使用当前源码 App 完成人工用户旅程验收；
10. 完成最终证据审计/独立复审。只有 P0=0、P1=0、所有 P2 被明确接受或关闭，且人工旅程通过后，才可签“产品链完成”；
11. 正常开发期间持续维护 `v0/DEVELOPMENT-STATUS.md`：中断、额度不足或失败时必须即时写入带时间的暂停快照；最终签字后再覆盖当前结论。禁止把已被后续复跑推翻的中间失败或旧构建结果继续写成最终状态。

**定向测试通过不等于组件签字；自动化签字不等于真实 API、作者价值或发布签字。**

#### 11.4.3 同一链路重复重开的止损规则

- 同一用户旅程在完成一次修复和验证后再次出现 P0/P1，必须暂停新增补丁，先做一次跨 Main/Preload/Renderer/磁盘的根因审查。
- 同一链路第二次被重新打开时，必须检查是否存在权威归属错误、缺失状态、非原子提交、测试未进入主链或旧产物/旧文档污染；不得默认继续扩大解析容错或增加重试。
- 单次真实 Electron 超时、GUI 沙箱启动失败或外部服务波动，在稳定复现前标记为“待复现”，不得直接升级成当前架构阻断；至少用同源码重跑和磁盘/IPC 证据区分稳定缺陷、环境限制与瞬时失败。
- 如果局部修复需要同时修改三层以上接口，先回到协议和状态机重新审查，再决定修补还是版本化重构。

#### 11.4.4 后续三条功能的强制应用

- **Research→Changes**：`writcraft.research-handoff/v1` 已完成契约、实现、强制 Electron reject/A→B 与当前源码 App 人工旅程；来源保持只读并进入 ChangeSet provenance。生产 apply transaction 以真实磁盘/History 关闭 committed-warning 动态故障注入，最终独立二审 P0=0/P1=0/P2=0。
- **Inline Rewrite**：已冻结并实现 selection/block anchor、target revision、`end_turn`、输出边界、保留路径禁写、Main capability/ACK、接受时依赖复核、durable reconciliation 和 Change History。0.1.2 真实作者验收进一步证明“快捷键存在”不等于用户旅程完整：`⌘K` 必须先冻结选区并打开本次改写要求输入框，提交前零保存/IPC/AI/指标；提交时再次校验 Range 与项目/文件/编辑会话身份。请求使用 exact v2 私有指令，公开 History/recovery/metrics 保持 v1 且不得保存原始指令或其 hash。`⌘L` 只负责项目/文件/选区 Chat。
- **Chapter 生成**：真实作者的 `b5.content` 红灯证明 strict envelope 通过不等于每个内容区块可用。只允许把 CRLF/外层换行规范化为传输格式；strict JSON/schema/block id 不修补、不重试。内容为空、NUL、字符或字节越界时，全章最多原位重生当前区块一次；retry 前必须重验 `edit.md`、目标与上下文 revision，不得携带失败模型正文。第二次失败零写入终止，不得拼出部分 ChangeSet。协议 prompt 中的 schema、blockId 和边界示例必须从当前 Main 权威对象动态生成；测试必须读取实际 prompt，并以非默认 ID 证明示例与后置校验一致，禁止 fixture 只返回预期答案而不验证收到的协议。
- **Changes 提交终态**：hunk 的“尚未写入”只属于预提交审阅态。Main/History 已确认可信提交且无 residual 后，Renderer 必须销毁全部旧 Diff、决定按钮和预提交文案，只发布一个与权威结果一致的完成终态；不得同时显示“尚未写入”和“已安全应用”。动态测试和真实 Electron 都必须断言旧 hunk DOM 为 0。
- **Plan 生成**：`docs/PLAN-STRICT-V1-CONTRACT.md` 已从文本 JSON 更新为工具协议。生产定义唯一 `submit_project_plan` 工具，以完整 `input_schema` 重复声明顶层/里程碑/任务的 required、array bounds、短 ASCII ID/依赖与 `additionalProperties:false`，并使用 named tool choice；Main 只接受 `stop_reason=tool_use` 且原始响应恰有一个同名、合法、plain-JSON 工具 input。thinking/text 不得成为 authority，旧 `end_turn` 文本 JSON、错误/多个/畸形 tool call 均失败关闭，绝不本地截取、剥围栏、trim ID、猜数组或静默回退。数组 shape/count 与 ID/依赖引用结构错误共享至多一次重试预算；重试不得携带失败 input，必须在第二次调用前重验文件树、`edit.md` 与全部显式上下文，第二次失败即终止。真实 Electron fixture 必须断言 forced tool/schema；Plan 定向门禁统一使用 `npm run verify:plan`。named forced 形态和本轮依赖字段仍必须通过一次真实 MiniMax canary，自动化不得冒充 provider 签字。
- **Plan 输出容量**：provider token 预算必须与最大合法工具 input 闭合，不能依赖 `thinking` 默认值或提示词“保持简洁”。Plan 的生成/Main/Renderer 合同共同限制一次迭代为两个里程碑、每个两个任务、每任务两个目标/两个依赖和短字段；禁止 C0/孤立 surrogate 并统一按 Unicode code point 计数后，填满全部计数、ID、唯一 80 字符 Emoji 路径与所有唯一 Emoji 列表/叙述字段的确定性 fixture 为精确 6,120 bytes，低于 6 KiB。路径上限必须覆盖当前验收项目，唯一目标上限必须等于结构真实可达的 8。保持既有 8192-token/90-second 上限；`max_tokens` 是终态失败，不进入结构重试，不得自动再付费、扩大所有工作流的全局预算，或接受截断响应中的部分/看似完整工具 input。
- **Graph 扩展验收**：`docs/GRAPH-ACCEPTANCE-V1-CONTRACT.md` 已签字；筛选/双证据/stale/作者纠错、failure live、键盘/AX、布局及大图性能已覆盖。后续韧性批又关闭 deferred async ownership、缓存/分析器完整语义权威、有界不可变 Renderer 快照与 Unicode quote 边界，独立二审 P0/P1/P2=0；0.0AB 当时总链为真实 Electron 35/35，当前证据见文首“当前实现停点”与 `v0/DEVELOPMENT-STATUS.md` 顶部。
- **Diagnostic Export**：`docs/DIAGNOSTIC-EXPORT-V1-CONTRACT.md` 已实现；Main 构造递归 allowlist JSON，Renderer 只显示精确预览并回传 token，原生保存拒绝覆盖并在失败时只清理由本次创建且 inode 相同的文件；取消、项目/导航漂移、TTL 跨 fsync 与并发替换均有动态门禁。
- **Image Review**：`docs/IMAGE-REVIEW-V1-CONTRACT.md` 已实现自动化主链与 Trash 扩展；Main 绑定窗口/项目/代际/资产，Renderer 只回传 token、评分、终态、可选费用及 Trash opaque capability。恢复/清空使用 transaction quarantine、inode/digest 双复核和 committed-state 精确重试，不修改 Markdown 或既有评审证据。

违反本节门禁产生的“测试全绿”不得写入发布判断，也不得作为继续堆叠新功能的依据。

## 12. Phase A 验收清单

- [x] 新建项目产生可读的 `edit.md` 和有效 `.writcraft/project.json`，不会覆盖已有文件。
- [x] 打开已有项目不要求移动或导入正文，所有正文仍在原目录。
- [x] 左侧文件树与磁盘一致，至少两个 Markdown 文件可切换编辑。
- [x] 标签页保持独立 buffer、dirty、光标和滚动状态，同一文件没有双重状态。
- [x] 保存采用临时文件 + fsync + rename，并返回新 revision。
- [x] 外部修改和并发保存被 revision 检查拦截，用户可比较和选择。
- [x] 路径穿越、绝对路径、symlink 逃逸和保留目录写入均被测试拒绝。
- [x] 崩溃或保存失败后能恢复未落盘草稿，且不会自动覆盖磁盘。
- [x] 旧 localStorage 草稿有可预览、可取消、幂等的迁移路径。
- [x] 旧 `editor.md` 只有在用户确认后迁移成 `edit.md`，双文件冲突不覆盖。
- [x] `edit.md` 保存后加入下一次 AI 请求，Context 中可核对来源与 revision。
- [x] renderer sandbox、context isolation 和窄 preload API 保持开启。
- [x] Phase A 地基、当前 Chat/Chapter 源码的单元/IPC 集成和强制真实 Electron 验收通过；失败证据不被静态 verify 掩盖。

> 历史证据边界（0.0AC 发布候选）：该批源码通过完整 test/verify、Persistent **3/3**、npm Preview **10/10**、installed **2/2**、同源码连续两轮真实 Electron **35/35** 和一次真实 Coding Plan 合成图片门禁；实现复审 P0/P1 已清零。registry 随后的公开发布与 0.0AL / 0.1.1 当前证据见文首；真实作者质量/采纳仍未关闭。

Phase A 只有在全部清单有可复现证据时才算完成；“页面看起来像工作区”或“测试只检查元素存在”都不构成验收。

## 13. Phase A 之后的接口承诺

Phase B 将在本地项目与 revision 契约上增加索引、Context Chips 和多文件 ChangeSet。Phase C 将使用项目相对路径、稳定块锚点和内容哈希写入图谱 Evidence。Phase A 的文件身份、revision 和保存接口因此属于长期契约，修改时必须提供迁移和回归测试。
