# AI 任务透明协作 v1 合同

> 适用版本：`writ-craft@0.3.0`（WRC-0.3.0-R1）
> 状态：**0.3.0 阶段 A–E 已完成、独立复审 P0=0/P1=0/P2=3，并随 0.3.0 Preview 发布后冻结。Chat、Navigation、Chapter、Research、Changes、Graph、图片、15 秒取消入口、60 秒硬超时、跨项目迟到结果、Context Manifest v2 和零写入边界均已有最终证据。本文件只作为 0.4.0 的兼容与回归约束；正文中的中间阶段“仍未完成”描述均为历史现场，不得派发旧任务。**

## 1. 目的

这份合同规定所有 AI 写作请求如何被 Main 识别、推进、取消和收口。它不是新的 AI 功能，也不替代 Navigation、Chat、Chapter、Research 或 Changes 的业务合同。它只提供跨入口的任务身份和作者可理解的状态边界。

## 2. 任务身份

每个任务必须由 Main 创建，并绑定以下字段；`attemptId` 键始终存在，未由调用方提供时以 `null` 请求 Main 生成：

- `taskId`：Main 生成的不透明任务 ID；
- `attemptId`：本次尝试的不透明 ID；同一任务重试必须使用新 attempt；
- `projectInstanceId`：项目实例身份；
- `targetLocator`：当前目标的结构化 locator，不接受 Renderer 绝对路径；
- `inputRevision`：建立上下文时的项目/正文 revision；
- `ownerToken`：Main 私有 owner 令牌，不发送给模型；
- `startedAt`：Main 时钟记录的开始时间。

这条 exact-key 约束同时适用于 Renderer→preload→Main 的窄桥和测试夹具；省略键不是“让 Main 自动补齐”的合法传输形态。

Renderer 只能收到去除 `ownerToken`、root path、Key 和能力令牌后的 public snapshot。项目切换、窗口导航或 revision 变化后，旧任务不再拥有发布结果的权限。

## 3. 阶段与终态

运行阶段固定为：

```text
preparing_context → checking_evidence → generating_suggestion
→ validating_result → waiting_review
```

允许的终态为：`review`、`needs_sources`、`committed`、`rejected`、`completed`、`cancelled`、`timed_out`、`failed`、`stale`、`conflict`。Main 必须把返回式 `REQUEST_ABORTED` 结算为 `cancelled`，不得在 Renderer 显示成通用失败。

任务进入 `waiting_review` 只表示预览已准备，不代表写入。只有现有 Changes/History 明确确认后，才可进入 `committed`。`cancelled`、`timed_out`、`failed`、`stale` 和 `conflict` 必须证明没有未确认写入。

## 4. 等待边界

- 运行超过 15 秒，Main 必须公布 `canCancel: true`；
- 运行超过 60 秒，Main 必须中止 provider 请求并结算为 `timed_out`；
- 取消、超时、项目切换和 revision 漂移都必须丢弃迟到结果；
- 不得自动重试或自动产生付费请求；
- 所有终态都保留作者目标、当前范围和可执行下一动作。

## 5. 进度事件

进度事件只能由 Main 产生，并至少包含：`schema`、`taskId`、`attemptId`、`projectInstanceId`、`phase`、`status`、`canCancel`。事件是提示，不是写入权限；Renderer 不得凭事件自行修改项目文件。旧 attempt 的事件必须被 Renderer 丢弃。

## 6. 写入边界

AI 结果只能成为预览或 Main-owned ChangeSet。`edit.md`、`references/**`、`sources/**` 等只读来源保持只读；正文写入必须经过现有 Diff、冲突检查、History 和 Safe Undo。不得通过放宽结构化校验、猜测自由文本或扩大 Renderer 权限修复任务失败。

## 7. 上下文引用与项目 Prompt

- Main 为每次上下文补全签发短期 `@ref:<catalogId>:<candidateId>`；Renderer 提交的引用必须与当前项目实例和 mutation revision 一致。
- Main 在 provider 调用前恢复引用对应的 canonical `@file`、`@section`、`@folder`、`@source` 或 `@entity` 语义；未知、过期、跨项目和 revision 漂移引用必须 fail-closed。
- Research 仍要求作者显式选择来源；Main 同时带入 `edit.md` 的有界编译快照，并把路径、revision、预算和截断状态写入 Context Manifest。
- 引用目录不包含正文内容、项目 root、Key 或写入能力；候选展示字段不等于提交权限。

## 8. 验收口径

专项测试必须覆盖：正常完成、15 秒取消可见、60 秒超时、provider 失败、重复提交、旧 attempt、旧 project、旧 revision、过期 `@ref`、Research edit.md manifest、迟到结果、零写入以及终态后的重试。阶段 A–E 最终证据已覆盖项目卡、Onboarding、workspace owner、写作导航、AI task、进度 Renderer、Main wiring、真实项目 Context Catalog、同 profile API Key 重启、watcher Main/IPC，以及 Chat、Navigation、Chapter、Research、Changes、Graph、图片的真实作者受影响路径。完整 Electron harness 的非固定时序红灯仍作为 P2 历史证据保留；它不表示跨入口验收未完成，也不能被绿灯抹除。真实 Electron 回归仍必须证明作者能看懂“目标、读取范围、阶段、是否写入和下一步”。
