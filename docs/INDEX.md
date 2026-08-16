# WritCraft 文档索引

本页是项目文档的唯一导航入口。文档按“当前权威、按功能读取、冻结兼容合同、历史归档”分层；不要全量读取 Markdown 后自行拼接下一任务。

## 开始开发前只读四类入口

1. **当前事实**：只读 [`../v0/DEVELOPMENT-STATUS.md`](../v0/DEVELOPMENT-STATUS.md) 顶部当前控制块，确认唯一 checkpoint、开放风险和下一动作。
2. **当前验收**：只读该 checkpoint 唯一直接相关的合同或矩阵。A1b 当前使用 [`0.4.0-A1B-EXISTING-STATE-MATRIX.md`](0.4.0-A1B-EXISTING-STATE-MATRIX.md) 与实际触及的 Changes/History 合同；不要把内部 E/R/V/F 或 schema/wire slice 当成独立签收点。
3. **工程事实**：只读受影响源码、测试和 `v0/package.json`。源码与可复现测试优先于文字快照。
4. **执行控制**：只在打开、暂停或签收 checkpoint 时读取 [`0.4.0-EXECUTION-PROTOCOL.md`](0.4.0-EXECUTION-PROTOCOL.md)。它控制 WIP/review/Stage 顺序，不改变产品范围。

只有需要判断版本、阶段或产品范围时，才读取 [`ROADMAP.md`](ROADMAP.md) 与 [`ROADMAP-0.4.0.md`](ROADMAP-0.4.0.md)；只有实际触及长期产品或稳定架构决策时，才读取 [`WRITCRAFT-PRD-V3.md`](WRITCRAFT-PRD-V3.md) 与 [`ARCHITECTURE.md`](ARCHITECTURE.md)。阶段 0 review、旧 checkpoint review、PRD、架构和冻结兼容合同都不是每次开发的必读材料。

0.2.0 的 [`ROADMAP-0.2.0.md`](ROADMAP-0.2.0.md) 与 [`DAILY-WORKSPACE-V1-CONTRACT.md`](DAILY-WORKSPACE-V1-CONTRACT.md) 已冻结；只有生产源码实际影响项目首页、大纲、`⌘P`、workspace/v2 或性能边界时才阅读并回归。

0.3.0 的 [`ROADMAP-0.3.0.md`](ROADMAP-0.3.0.md) 与 [`AI-TASK-TRANSPARENCY-V1-CONTRACT.md`](AI-TASK-TRANSPARENCY-V1-CONTRACT.md) 已冻结；只有生产源码实际影响跨入口 AI 任务、Context Manifest、取消/超时或零写入边界时才阅读并回归。

0.3.0 阶段 E 的独立复审签收记录见 [`0.3.0-STAGE-E-INDEPENDENT-REVIEW.md`](0.3.0-STAGE-E-INDEPENDENT-REVIEW.md)；它记录 P0=0、P1=0、P2=3 和候选状态，不代表正式发布授权。

`ROADMAP-0.2.0.md` 已于 2026-08-03 获得所有者批准并生效。原审阅稿已直接转为该版本合同，不保留第二份活动路线图。

`ROADMAP-0.3.0.md` 已于 2026-08-04 获批并完成阶段 0 → E，0.3.0 已发布为 npm/GitHub Developer Preview。

`ROADMAP-0.4.0.md` 已于 2026-08-06 获批为 `WRC-0.4.0-R1`；所有者随后提交了其中 §11 的完整目标模式文本。阶段 0 已完成并由独立复审以 P0=0、P1=0、P2=4 签收。2026-08-11 完成封版距离审计后，执行方式切换为 `WRC-0.4.0-EXEC-R1` 受约束里程碑恢复；当前只允许 Stage A，Stage B 冻结等待 A→B 重签，C/D/E 禁止开工。

## A1b 历史 component evidence（不可派工）

以下记录保留首红、修订和当时的 hash/diff 证据，但它们不是当前状态账本、不是新的 checkpoint，也不能以“final binding pending”阻断 A1b 内部相邻实现。A1b 只在完整 mixed EXISTING/`ROLLBACK_CREATE` checkpoint 出口独立复审一次：

- [`0.4.0-A1B-E1-PARITY-REVIEW.md`](0.4.0-A1B-E1-PARITY-REVIEW.md)
- [`0.4.0-A1B-E2A-BEFORE-AUTHORITY-REVIEW.md`](0.4.0-A1B-E2A-BEFORE-AUTHORITY-REVIEW.md)
- [`0.4.0-A1B-E2B-LOCATOR-SCHEMA-REVIEW.md`](0.4.0-A1B-E2B-LOCATOR-SCHEMA-REVIEW.md)
- [`0.4.0-A1B-E2B-PRIMARY-E-REVIEW.md`](0.4.0-A1B-E2B-PRIMARY-E-REVIEW.md)
- [`0.4.0-A1B-E3-JOURNAL-SCHEMA-REVIEW.md`](0.4.0-A1B-E3-JOURNAL-SCHEMA-REVIEW.md)
- [`0.4.0-A1B-E3-JOURNAL-BINDING-SCHEMA-REVIEW.md`](0.4.0-A1B-E3-JOURNAL-BINDING-SCHEMA-REVIEW.md)

## 历史复审与发布记录

以下复审与发布记录保留追溯价值，不再进入当前派工入口：

- [`0.4.0-A0-EXECUTION-GATE-REVIEW.md`](0.4.0-A0-EXECUTION-GATE-REVIEW.md)：A0 可执行门禁独立复核记录（2026-08-11，`WRC-0.4.0-EXEC-R1`）。
- [`0.4.0-STAGE-0-INDEPENDENT-REVIEW.md`](0.4.0-STAGE-0-INDEPENDENT-REVIEW.md)：0.4.0 阶段 0 独立复审记录（2026-08-06，P0=0/P1=0/P2=4）。
- [`RELEASE-NOTES-v0.2.0.md`](RELEASE-NOTES-v0.2.0.md)：历史 0.2.0 发布说明。

## 派工权与冻结关系

| 文档层级 | 文件 | 是否可派工 |
|---|---|---|
| 当前版本顺序 | `ROADMAP.md` | 是；只决定当前/下一版本、范围和非目标 |
| 当前详细合同 | `ROADMAP-0.4.0.md`、`EVIDENCE-DELIVERY-V1-CONTRACT.md` | 是；阶段 0 已关闭，当前只从阶段 A 开放项派工，按 A → B → C → D → E 推进 |
| 当前执行控制 | `0.4.0-EXECUTION-PROTOCOL.md` | 是；只决定当前 checkpoint、WIP、停止条件、证据阶梯与测试注册，不得改变产品范围 |
| 当前事实账本 | `v0/DEVELOPMENT-STATUS.md` | 是；只从其中尚未关闭的当前阶段和开放项续作 |
| 长期产品/稳定架构 | `WRITCRAFT-PRD-V3.md`、`ARCHITECTURE.md` | 只约束边界，不能自行新增当前版本任务 |
| A1b micro review | `0.4.0-A1B-E*-REVIEW.md` | 否；仅为 historical component evidence，不是 checkpoint、状态或派工门禁 |
| 冻结兼容合同 | 0.1.x–0.3.0 路线图、`*-V1-CONTRACT.md`、阶段复审记录 | 否；只有 0.4.0 实际触及对应生产边界时才作为兼容与回归约束 |
| 历史材料 | `docs/archive/`、`raw/`、`deliverables/` | 否；仅追溯证据，不得恢复旧 TODO、里程碑或目标模式文本 |

旧路线图中的“下一动作”“目标模式已启动”“等待发布/授权”等文字，即使为当时真实记录，也不得覆盖本页、`ROADMAP.md` 和当前状态账本。若旧合同的安全边界与新实现发生冲突，先按源码和当前测试确认事实，再在 0.4.0 合同中明确兼容或迁移，不能直接从旧文档派发工作。

## 用户与发布

- [`../README.md`](../README.md)：产品首页。
- [`GETTING-STARTED.md`](GETTING-STARTED.md)：安装与首次使用。
- [`NPM-DEVELOPER-PREVIEW-V1-CONTRACT.md`](NPM-DEVELOPER-PREVIEW-V1-CONTRACT.md)：npm Preview 分发合同。
- [`RELEASE-NOTES-v0.1.2.md`](RELEASE-NOTES-v0.1.2.md)：历史 0.1.2 Preview 说明。
- [`RELEASE-NOTES-v0.2.0.md`](RELEASE-NOTES-v0.2.0.md)：历史 0.2.0 Preview 说明。
- [`RELEASE-NOTES-v0.3.0.md`](RELEASE-NOTES-v0.3.0.md)：当前公开 0.3.0 透明 AI 协作 Preview 说明。
- [`../SECURITY.md`](../SECURITY.md)、[`../CONTRIBUTING.md`](../CONTRIBUTING.md)：安全与贡献。

## 冻结兼容合同（按受影响模块读取）

`CHANGES-HISTORY-RECOVERY-V1-CONTRACT.md` 是双角色文件：其 0.1.x 冻结部分约束兼容回归；其 0.4.0 Snapshot extension 部分（头部声明 "0.4.0 Snapshot extension under Stage A independent review"）是当前权威，读取该文件时先看头部状态块。`EVIDENCE-DELIVERY-V1-CONTRACT.md` 是命名例外：虽用 `-V1-CONTRACT` 命名，但属于当前 0.4.0 合同（见“派工权与冻结关系”），不是冻结合同。

这些合同描述 0.1.2 已公开行为。它们约束兼容和回归，但不是当前 TODO：

- Changes/History：`CHANGES-HISTORY-RECOVERY-V1-CONTRACT.md`
- Chat：`CHAT-CONVERSATION-V1-CONTRACT.md`
- Context：`EDIT-PROMPT-CONTEXT-V1-CONTRACT.md`
- Inline：`INLINE-REWRITE-V1-CONTRACT.md`
- Graph：`GRAPH-ACCEPTANCE-V1-CONTRACT.md`
- Research：`RESEARCH-ACCURACY-V1-CONTRACT.md`、`RESEARCH-CHANGES-V1-CONTRACT.md`
- Navigation：`WRITING-NAVIGATION-V1-CONTRACT.md`、`UNIFIED-WRITING-TASK-V1-CONTRACT.md`
- Image：`IMAGE-REVIEW-V1-CONTRACT.md`
- Trash：`MARKDOWN-TRASH-V1-CONTRACT.md`
- Diagnostics：`DIAGNOSTIC-EXPORT-V1-CONTRACT.md`

只在生产源码实际影响对应模块时阅读其合同并重验相关路径。

## 历史归档

[`archive/README.md`](archive/README.md) 列出旧 Plan、Phase A、0.1.x 全量账本、早期复盘和旧发布说明。归档材料保留失败证据和设计原因，但不拥有当前派工权。

`raw/` 是研究输入，`deliverables/` 是早期产品叙事；两者都不是产品合同。Git 历史负责保存被去重或迁移前的原貌。

## 冲突处理

不同问题使用不同权威，不把职责不同的文件排成一条会互相覆盖的总排名：

- **现在实际是什么**：当前源码与可复现测试 → `v0/DEVELOPMENT-STATUS.md` → 对应现行合同。
- **当前版本是否应该做**：只由 `ROADMAP.md` 决定；审阅稿、PRD、归档 checklist 和源码残留都不能自行扩大范围。
- **长期产品要成为什么**：由 `WRITCRAFT-PRD-V3.md` 定义；进入哪个版本仍回到路线图决定。

发现冲突后先按上述职责校准文档，再继续开发；不得选择对继续开发最方便的旧描述。
