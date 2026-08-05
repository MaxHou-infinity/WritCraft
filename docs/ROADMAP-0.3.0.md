# 笔触 WritCraft 0.3.0 开发路线图（生效合同）

> 路线图编号：`WRC-0.3.0-R1`
> 对应产品版本：`writ-craft@0.3.0`
> 版本主题：透明 AI 协作
> 当前状态：**阶段 0–E 已完成，0.3.0 已按授权发布为 npm `preview` 和 GitHub prerelease。阶段 E 的所有者选定目录经临时去除私有防嵌套标记后，由生产 copy transaction 创建隔离副本；获批 GUI 环境 `author-cross-entry` 1/1 与 `author-affected` 1/1 通过，覆盖 Chat、Navigation、Chapter、Research、Changes、Graph、图片、取消、60 秒硬超时、跨项目迟到结果、同项目 `edit.md` revision 漂移、来源不足恢复、Diff/冲突/接受/Safe Undo 和零写入。五入口统一 Context Manifest v2 的 exact envelope、UTF-8 字节语义、预算、遗漏/截断/不可用原因及相对路径边界已通过专项与真实作者对照；当前 `npm test` 和获批 GUI `npm run verify` 均退出码 0。阶段 E 独立复审已签收：P0=0、P1=0、P2=3；大型 Electron harness 时序红灯、quick-open 单次性能红灯、源目录私有防嵌套标记首红均保留为明确证据，不得改写成产品绿灯。npm 公网隔离安装验证 2/2，`preview:0.3.0`、`latest:0.1.0`；0.3.0 仍是 Developer Preview，不等同于稳定版或 App/ZIP 分发。**

本版本不是再增加一套 AI 功能，而是让现有 AI 写作能力变得可理解、可控、可恢复。作者应该始终知道：AI 当前在处理什么、读取了哪些内容、为什么没有继续，以及接受后到底会写入什么。

## 1. 一句话目标

作者在一次写作任务中，可以看到清晰的目标、上下文、处理阶段和 Diff；可以取消、重试或调整范围；AI 的结果始终停留在预览，只有作者确认后才写入正文。

## 2. 解决的真实问题

0.2.0 解决了“项目在哪里、从哪里继续写”。但现有 AI 任务仍可能出现：

1. “处理中”持续太久，作者不知道是在工作、等待还是失败。
2. 作者无法判断 AI 实际读了哪些文件，也无法解释结果从何而来。
3. `edit.md`、当前文件和临时上下文在不同入口重复拼装，容易造成目标漂移。
4. `@` 引用、取消、项目切换和外部修改可能产生迟到结果或过期 Diff。

## 3. 当前源码核对结论

本草案以 2026-08-04 的当前源码和本机运行数据为基准，不以旧团队文档的“计划完成”描述代替事实：

| 能力 | 当前实际情况 | 0.3.0 处理方式 |
|---|---|---|
| API Key 持久化 | 已有 `api-key-config-service.js`：Main 将 Key 原子写入 `ai-config.json`，权限 `0600`；`user-data-service.js` 将默认 profile 固定到 `~/Library/Application Support/WritCraft` 并迁移旧 profile | 不重复开发存储；补齐“同一 profile 重启后恢复”的真实 Electron 验收、profile 说明和异常恢复 |
| AI 任务状态 | Navigation 已有 attempt、owner、15 秒取消和 60 秒硬超时；其他入口仍存在各自状态语义 | 统一跨入口显示和终态，不重写已通过的 Navigation 边界 |
| `@` 引用 | `src/shared/context-selection.js`、Main resolver 和 Context Inspector 已支持解析/展示部分引用 | 补齐统一补全入口、来源目录和跨入口一致的 Context manifest |
| Context manifest | Chat、Navigation、Research、Chapter、Changes 均已有 Main-owned manifest 输出和 revision 绑定 | 统一 v2 envelope、UTF-8 字节/预算/遗漏语义，并以五入口对照和真实作者漂移证据签收 |

### API Key 体验判定

默认启动不带 `--profile` 时，生产代码应复用同一个稳定目录；显式 `--profile <目录>` 是有意的隔离配置，换目录就不会共享 Key。同一 profile 的“保存 → 完全退出 → 重启 → 状态恢复 → 发起请求”已由真实 Electron 专项 1/1 证明；密码框重启后为空仍是避免明文回显的安全设计，不再作为 0.3.0 未决缺口。

设置页每次打开都会主动清空密码输入框，这是避免明文回显的安全设计；空输入框不等于 Key 未保存。当前 UI 必须把“输入框为空”和“本机已配置”明确分开显示，真实验收以状态行和一次 AI 请求为准。

## 4. 冻结的产品原则

1. **一个任务、一条主线**：任务状态显示在当前 AI 面板或正文审阅区，不新增独立“任务驾驶舱”。
2. **披露而非猜测**：展示 Main 确认过的文件、章节、来源、revision 和截断原因，不让模型自行复述权威路径或原文。
3. **预览优先**：任何 AI 调用只能生成建议或 Diff；Changes 仍是唯一写入边界。
4. **失败可恢复**：取消、超时、项目切换、revision 漂移和迟到结果都必须保留目标并安全丢弃过期能力。
5. **不扩大模型与数据边界**：不新增模型供应商、不上传未授权文件、不建立跨项目记忆。

## 5. 必须交付的能力

### 5.1 统一 AI 任务状态（最小可见状态条）

- 状态固定为：准备上下文 → 核对来源 → 生成建议 → 校验结果 → 等待审阅 → 已接受/已拒绝/已取消/失败。
- 每个任务绑定 `projectInstanceId`、不透明 `attemptId`、目标 locator、输入 revision 和 owner token。
- 15 秒后显示取消；60 秒硬超时；取消、失败和超时均可直接重试且不写入文件。
- 任务完成后保留摘要、耗时、错误码和下一动作；不把旧的 `plan/*` metrics 当作当前任务状态。

### 5.2 `@` 上下文引用

- 在 Chat、导航、Chapter 和正文 AI 入口提供统一补全：文件、文件夹、章节、实体、来源和 Graph 问题。
- 引用显示为可展开 Context Chip；提交前可查看实际纳入、排除、截断和原因。
- Main 生成 revision 绑定的候选目录；Renderer 只提交不透明 ID，禁止自行拼接绝对路径或读取文件。
- 未知、重复、跨项目、过期或 revision 不匹配的引用 fail-closed，并给出可执行的修复动作。

### 5.3 `edit.md` 项目 Prompt 编译器

- 将 `edit.md` 的主旨、目标读者、结构、语气、硬约束、关键变量和来源规则编译成统一的只读 Context manifest。
- Chat、导航、Chapter、Research 和图片相关文本任务共用同一编译入口；不改变各模块的审阅/写入合同。
- 本阶段统一 `writcraft.context-manifest/v2` 的范围是 Chat、Navigation、Research、Chapter、普通 Project Changes 五个提案入口；Inline Rewrite（`⌘K`）继续受冻结的 `INLINE-REWRITE-V1-CONTRACT.md` 与 `writcraft.context-manifest/v1` capability 合同约束，不属于本阶段 v2 迁移，也不扩大其写入权限。
- Manifest 显示字段来源、优先级、缺失项和长度预算；用户修改 `edit.md` 后，旧任务不可继续使用旧 manifest。
- 不要求 AI 返回完整 Prompt；模型只消费 Main 已冻结的分区和引用 ID。

## 6. 分阶段路线

| 阶段 | 交付 | 退出条件 |
|---|---|---|
| 0 | 合同冻结与历史清理 | 任务状态、引用 ID、manifest、超时和写入边界合同完成；旧 `plan/*` 仅保留兼容读取 |
| A | Main 任务状态机与 owner 绑定 | **已完成并通过专项、完整回归和真实作者证据**；Main 统一 task/attempt/owner/project/revision、15 秒取消、60 秒硬超时、项目切换和迟到结果丢弃；Chat/Navigation/Chapter/Research/Graph/Changes/图片受影响路径均已覆盖，取消/失败/超时零写入 |
| B | `@` 引用目录与 Context manifest | **文件/文件夹/章节/段落补全与短期 request-bound opaque ID 已接入；真实项目候选 1/1、Context Catalog Main IPC Electron 1/1 已通过，短 TTL 过期与 Chat 恢复提示也已通过**，证明有效引用可进入统一项目上下文，edit.md revision 漂移、foreign project identity 和过期引用会 fail-closed；真实作者五入口使用同一 Main-owned Manifest envelope |
| C | `edit.md` 编译器与统一入口 | **Chat/Navigation/Chapter/Changes/Research 已复用 Main 编译入口**；真实作者五入口 revision 漂移旧结果丢弃、五入口统一 Manifest 字段/预算/遗漏语义和 compile-invalid fail-closed 已通过 |
| D | Renderer 任务条与 Context 披露 | **已完成并通过专项、完整回归和真实作者证据**；项目卡 focused Electron 4/4、动态 Renderer 30/30、workspace owner 4/4、Chat 任务进度 1/1、统一写作任务 focused Electron 1/1；真实作者路径覆盖 Navigation/Chapter/Research/普通 Changes/Graph/图片的任务阶段、取消/恢复、Diff、冲突、接受与 Safe Undo |
| E | 真实作者验收与发布候选 | **阶段 E 独立复审已签收，P0=0、P1=0、P2=3；0.3.0 已发布为 npm `preview` 和 GitHub prerelease**；真实作者选定目录经临时去除私有 `.writcraft/author-acceptance-copy.json` 后由生产 copy transaction 创建隔离副本，`e2e:electron:author-cross-entry` 1/1 与 `author-affected` 1/1 均通过。证据覆盖 Chat、Navigation、Chapter、Research、普通 Changes、Graph、正文 Diff、冲突阻止、Chat 取消/60 秒硬超时、Navigation/Chapter/Research/Graph/图片取消、五入口 `edit.md` revision 漂移旧结果丢弃、五入口统一 Manifest、来源充足/不足“添加来源”双分支、添加来源后原 action identity 保留并回到 review、跨项目 A→B 迟到结果丢弃且 A/B 零写入、图片预览/废纸篓/插入、接受与 Safe Undo；`npm test`、获批 GUI `npm run verify` 与公网隔离安装验证 2/2 均为 0。Tag/Release commit 为 `a747683`；`preview:0.3.0`、`latest:0.1.0`。首红与 P2 已记录在阶段 E 复审文档，不能把 Developer Preview 写成稳定版。 |

## 7. 明确不做

- 不做 Autopilot、整本书自动生成或连续批量改写。
- 不做新的 Plan/里程碑/任务驾驶舱，也不恢复退役的 `submit_project_plan`。
- 不做云同步、多人协作、账户、跨项目记忆或付费套餐。
- 不同时接入多个模型供应商，不以扩大上下文或放宽校验解决失败。
- 不重做 0.2.0 项目首页、大纲、`⌘P`、workspace/v2、Graph 基础协议或图片安全合同。

## 8. 验收标准

1. 作者从 Chat、导航或 Chapter 发起任务后，始终能看到当前目标、实际上下文和阶段状态。
2. 15 秒可取消，60 秒内成功或明确失败；任何终态都不产生未确认写入。
3. `@` 引用能定位到真实文件/章节/来源，过期引用不能生成 Diff。
4. 同一个 `edit.md` Manifest 在 Chat、Navigation、Research、Chapter、Changes 五条入口中字段语义、优先级、预算和缺失原因一致。
5. 接受、拒绝、冲突阻止和 Safe Undo 继续通过，且已有 0.2.0 工作区能力不回归。
6. 真实作者能够用一句话解释“AI 做了什么、读了什么、下一步是什么”。

## 9. 发布与文档门禁

- 本文件已于 2026-08-04 获所有者审阅通过，现作为 0.3.0 生效合同；唯一的 0.3.0 目标模式已启动，后续按阶段边界推进。
- 生效前必须同步 `docs/ROADMAP.md`、`v0/DEVELOPMENT-STATUS.md`、相关 Context/Navigation/Changes 合同和 Nowledge Mem。
- 每个阶段只提交一个可运行、可验证的边界；自动化全绿不能替代真实作者路径。
- 发布后保留所有真实红灯和 P2 风险，不用后续绿灯覆盖历史证据；本轮已完成经授权的 npm、Tag 和 GitHub Release，未分发 App/ZIP。`latest` 不移动；稳定版仍需新的候选、独立验收和单独授权。
