# WritCraft 稳定架构与维护边界

> 状态：当前工程入口。由已完成的 Phase A 规格提炼；历史实施过程见 `archive/contracts/PHASE-A-IMPLEMENTATION.md`。

## 1. 进程与权限

- **Main 是唯一权威**：负责项目根、文件读写、revision、watcher、索引、网络、能力 token、ChangeSet、History 和恢复事务。
- **Preload 是窄桥**：只暴露明确、可验证、可取消的 IPC；不得透传任意路径、URL、Key、文件内容或 Main 对象。
- **Renderer 只表达用户意图**：展示权威快照并提交 opaque ID、范围和决定；不得访问 Node、直接联网或把 DOM/缓存当成磁盘真相。
- **依赖只能向权威方向收敛**：Main 禁止引用 Renderer。Main 与 Renderer 都需要的无副作用解析/定位逻辑放入 `src/shared/`，由两端共用并做行为等价测试；共享模块不得取得文件、网络或 Electron 权限。
- 所有 AI 正文修改在确认前只生成预览，写入必须经过 Changes/Diff 和作者明确决定。

## 2. 项目与路径权威

- 每个项目由 exact project instance、canonical root 与 mutation generation 共同标识。
- 所有项目相对路径必须通过既有路径合同；禁止绝对路径、父级逃逸、符号链接/硬链接混淆和 Unicode 身份改写。
- watcher/flush 必须在 Main 中收敛外部变化。无法证明最新状态时 fail closed，不以等待时间推断权威。
- 项目切换、同项目重开、Renderer 销毁和迟到结果必须隔离；旧项目结果不能改变新项目的文件或 UI。

## 3. 异步所有权

- 每次长操作绑定 exact owner、attempt/generation、project instance 和依赖 revision。
- 每个内部 `await` 后以及任何状态、UI、文件或 capability 副作用前重新验证所有权。
- 超时、取消、失败、迟到和项目漂移进入有界终态；owner-only `finally` 只能清理自己创建的 busy、timer 和 capability。
- 已提交事务以磁盘/History/recovery marker 为真相，不能因响应丢失重放写入。

## 4. 写入、审阅与恢复

- 写入前冻结目标、revision、locator、权限和失败矩阵。
- 文件与 History 事务必须区分 proven uncommitted、proven committed 和 unknown；unknown 不能按失败清理。
- Safe Undo、冲突检测、recovery marker、目录 fsync 与 authoritative reload 是写入链的一部分，不是可选补丁。
- 提交后 UI 必须发布 Main 返回的 authoritative terminal truth；可选刷新失败不能掩盖已提交事实。

## 5. 本地索引和工作区

- 文件树、全文搜索、Graph、标题索引和 0.2.0 工作区聚合应复用 Main 权威快照，不建立互相竞争的扫描器。
- workspace 持久化只保存有界 UI 状态；恢复前校验项目、路径和 schema。文件消失或 revision 漂移时安全降级。
- 待审 ChangeSet 当前是进程内能力；未建立独立持久化事务前，不得向用户承诺重启后恢复。

## 6. 网络、隐私与证据

- Renderer 零网络；Main 只访问 allowlist provider，并执行请求上限、deadline、零自动 POST retry 和稳定错误脱敏。
- Key 只进入用户数据安全存储，不写项目、日志、截图、诊断或 Nowledge Mem。
- 真实作者项目只能使用所有者指定的隔离副本。证据默认只保存时间、稳定错误、数量、耗时、revision/hash 和决定等内容无关字段。
- 真实稿截图、录屏和正文片段不得进入 Git、测试日志或记忆；只有 fixture 或明确授权且脱敏的材料可留存。

## 7. 代码与测试要求

- CommonJS、两空格、单引号、分号、`const` 优先；模块使用 kebab-case。
- 0.2.0 新增或实质修改的 service、IPC/preload 与复杂状态对象写明输入、输出、稳定错误、权限所有者和副作用。
- 新 IPC 使用独立 service/handler 接入；不继续把业务逻辑堆入 `main.js`，也不借 0.2.0 发起全量重写。
- 注释解释权限、并发、事务、兼容性和非显然算法的“为什么”与不变量，不复述语法。
- 成功测试之外必须覆盖超时、取消、项目切换、外部修改、stale、重复请求、损坏状态和部分提交。
- 验收顺序：确定性专项测试 → 完整回归 → 真实 Electron harness → Computer Use 补充视觉/系统交互 → 一次最短作者主观旅程。

## 8. 变更纪律

先冻结产品合同、状态/失败矩阵和权威边界，再实现最小纵切。生产源码、测试和受影响文档进入同一变更。每个耐久里程碑更新当前状态和 Nowledge Mem；历史红灯不得被绿灯覆盖。
