# WritCraft 文档索引

本页是项目文档的唯一导航入口。文档按“当前权威、按功能读取、冻结兼容合同、历史归档”分层；不要全量读取 Markdown 后自行拼接下一任务。

## 开始任何开发前必读

1. [`ROADMAP.md`](ROADMAP.md)：唯一正式版本顺序、范围和非目标。
2. [`ROADMAP-0.2.0.md`](ROADMAP-0.2.0.md)：当前版本的已批准详细合同与阶段门禁。
3. [`../v0/DEVELOPMENT-STATUS.md`](../v0/DEVELOPMENT-STATUS.md)：当前事实、开放风险和下一动作。
4. [`ROADMAP-0.3.0.md`](ROADMAP-0.3.0.md)：当前 0.3.0 生效合同、阶段顺序和验收门禁。
5. [`WRITCRAFT-PRD-V3.md`](WRITCRAFT-PRD-V3.md)：长期产品契约。
6. [`ARCHITECTURE.md`](ARCHITECTURE.md)：稳定工程边界。
7. `v0/package.json` 与实际源码/测试：最终工程事实。

当前阶段 A 还必须阅读 [`DAILY-WORKSPACE-V1-CONTRACT.md`](DAILY-WORKSPACE-V1-CONTRACT.md)：它冻结 0.2.0 项目首页、大纲、`⌘P`、共享定位、workspace/v2、5 秒降级和性能验收边界。

0.3.0 阶段 A–D 还必须阅读 [`AI-TASK-TRANSPARENCY-V1-CONTRACT.md`](AI-TASK-TRANSPARENCY-V1-CONTRACT.md)：它冻结跨入口任务身份、状态、取消/超时、进度事件和零写入边界。

0.3.0 阶段 E 的独立复审签收记录见 [`0.3.0-STAGE-E-INDEPENDENT-REVIEW.md`](0.3.0-STAGE-E-INDEPENDENT-REVIEW.md)；它记录 P0=0、P1=0、P2=3 和候选状态，不代表正式发布授权。

`ROADMAP-0.2.0.md` 已于 2026-08-03 获得所有者批准并生效。原审阅稿已直接转为该版本合同，不保留第二份活动路线图。

`ROADMAP-0.3.0.md` 已于 2026-08-04 获所有者批准并成为 0.3.0 生效合同；目标模式已启动，按阶段 0 → E 派发编码任务，当前以路线图与 `v0/DEVELOPMENT-STATUS.md` 的实时证据为准。

## 用户与发布

- [`../README.md`](../README.md)：产品首页。
- [`GETTING-STARTED.md`](GETTING-STARTED.md)：安装与首次使用。
- [`NPM-DEVELOPER-PREVIEW-V1-CONTRACT.md`](NPM-DEVELOPER-PREVIEW-V1-CONTRACT.md)：npm Preview 分发合同。
- [`RELEASE-NOTES-v0.1.2.md`](RELEASE-NOTES-v0.1.2.md)：当前公开 Preview 说明。
- [`RELEASE-NOTES-v0.3.0.md`](RELEASE-NOTES-v0.3.0.md)：0.3.0 透明 AI 协作候选/发布说明。
- [`../SECURITY.md`](../SECURITY.md)、[`../CONTRIBUTING.md`](../CONTRIBUTING.md)：安全与贡献。

## 冻结兼容合同（按受影响模块读取）

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
