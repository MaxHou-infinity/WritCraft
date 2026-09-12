# A2a 移植施工单（快照 create/list App 接线）

> 状态：**一次性施工准备记录**。不拥有派工权，不是 checkpoint、不是签收证据。
> 派工仍以 `docs/0.4.0-EXECUTION-PROTOCOL.md` 与 `v0/DEVELOPMENT-STATUS.md` 为准。
> 生成于 2026-09-11，目的是让 A2a 可以在新会话中**立刻开工**，无需重建上下文。

## 0. 前置门禁（未满足不得开工）

1. A1b 必须已由**独立 reviewer** 定点确认 P0=0/P1=0（绑定本地 commit `1f43b7f`）。
   协议明令：前序 checkpoint 未签收不得并入下一项生产代码。
2. 所有者已授权顺序变更：**A1b 签收 → A2a → A1c**（见执行协议 2026-09-11 修订）。

## 1. 移植源（禁止重写）

**`codex/a1b-complete` 的 `8880709`
`feat(snapshot): expose create and list in project home`**

按协议 §4.1 的分类：**复用/移植候选**，**不是合并对象**。理由：该提交早于当前
WRCCHRJ2 schema 与冻结的 ACK 状态机；归档处置亦写明「A2a 开启前不得进入 main；
届时按 production IPC/preload/Renderer 与 real Electron 要求重新评估」。

### 1.1 它动了哪些文件（实测）

| 文件 | 规模 | 处理 |
|---|---|---|
| `v0/src/main/snapshot-handler.js` | **新增 +205** | 移植（A2a 的 Main handler 层，main 今天完全没有） |
| `v0/src/main/main.js` | +202 | 只取 snapshot 相关 IPC 注册，**不要**整段照搬 |
| `v0/src/main/preload.js` | +26 | 窄桥，移植 |
| `v0/src/main/project-service.js` | +74 | 移植并核对当前 API |
| `v0/src/main/snapshot-storage-worker.js` | +12 | 移植 |
| `v0/native/snapshot-storage-helper.c` | **+225** | 移植，**必须重建 binary** |
| `v0/src/renderer/index.html` | +18 | 移植（注意脚本加载顺序是 load-bearing） |
| `v0/src/renderer/project-home-view.js` | +184 | 移植 |
| `v0/src/renderer/sources-view.js` | +8 | 移植 |
| `v0/tests/verify-v0-snapshot-create-list-electron.js` | **新增 +171** | 移植并**登记清册** |
| `v0/tests/0.4.0-test-gates.json` | +11 | **不要直接套用**，按当前清册重做 |
| `v0/DEVELOPMENT-STATUS.md`、`docs/0.4.0-EXECUTION-PROTOCOL.md` | 文档 | **不移植**（属历史记录，当前控制块已更新） |
| native binaries | 二进制 | 用 `npm run build:native-helper` 重建，不要直接抄 |

## 2. 依赖与利好（已实测）

- `snapshot-handler.js` 是**薄 IPC 层**：只 `require('./evidence-delivery-schema')`，
  并强制要求 `options.snapshotService.create` 存在（`snapshot-handler.js:41-42`），
  实际调用于 `:169`。
- 因此 A2a **会接线 `v0/src/main/snapshot-service.js`（384 行）** —— 该模块目前在
  main 里是"孤儿"（无生产 require），但它是 **A2a 的既定依赖，不是死代码**。
  **严禁把它当孤儿删除或精简掉。**
- `snapshot-service.js` 的依赖只有 `crypto` + `./evidence-delivery-schema`，
  **与 changes-history / journal schema 零耦合**（实测 0 命中）。所以它不需要为
  WRCCHRJ2 代际做适配，A2a 在服务层**基本可以直接接线**。
  → 本任务的实质是**移植**，不是重写。

## 3. 必须遵守的约束

- 一次只允许 **1 个主 checkpoint + 最多 1 个不修改同一 authority 的支持任务**。
- 新增/改名 `verify-v0-*.js` **必须在同一 change set 进入清册与当前顶级 gate**
  （`tests/0.4.0-test-gates.json`；当前 `expectedTestCount` = 53，脚本总数 222）。
- Main 保持文件系统、revision、capability、network、事务与恢复权威；Renderer 不得
  提交绝对路径、正文或内容权威，不得绕过 ChangeSet/History 审阅。
- 新 IPC 走聚焦的 service/handler，**不要继续往 `main.js` 堆逻辑**。
- 仅本地 commit；**禁止 push / tag / release / publish / 分发**。
- Stage B/C/D/E 继续冻结。

## 4. 施工步骤建议

1. 读当前 `snapshot-service.js` / `snapshot-storage-worker.js` / `snapshot-capability-store.js`
   与 `main.js` 里既有的 Stage B snapshot 只读 IPC（`list-delivery-snapshots` 等），
   确认 A2a 的 create/list 不与它们冲突。
2. `git show 8880709:v0/src/main/snapshot-handler.js` 取全文，按当前 schema 与
   `publicFailure` 错误投影约定适配。
3. native：`git show 8880709:v0/native/snapshot-storage-helper.c` 与当前版本三方对照后
   定向适配，`npm run build:native-helper` 重建。
4. IPC/preload：只加 A2a 需要的窄通道；Renderer 只发 opaque id 与作者选择。
5. Renderer：按 `index.html` 的脚本顺序约束插入，保持现有范式（render-on-mutate
   或 reducer，与目标视图一致）。
6. 新增 Electron 用例并登记清册；跑 focused gate。
7. checkpoint 出口**独立复审一次**，再形成 clean local checkpoint commit。

## 5. 验证清单

```
cd v0
node --check <每个改动的 JS>
npm run build:native-helper
node tests/verify-v0-snapshot-create-list-electron.js
node tests/0.4.0-test-gates.json 相关 gate
node tests/check-v0-0-4-test-registration.js --check
npm run verify:0.4:current-components
node scripts/check-syntax.js
```

注意：本机 `npm test` 的最后一步 packaging 检查因本机 **npm 12.0.2 / node 26**
超出 `package.json` 声明的 `engines`（`npm >=10 <12`）而必然失败（npm 12 的
`npm pack --dry-run --json` 输出对象而非数组）。**不要为此放宽该冻结门禁**；
完整 `npm test` 应在合规工具链或 CI（node 22 → npm 10）上跑。
