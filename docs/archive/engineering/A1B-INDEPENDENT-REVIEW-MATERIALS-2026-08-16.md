# A1b 独立复审材料（2026-08-16）

> 目的：为 A1b mixed EXISTING + `ROLLBACK_CREATE` 的独立 reviewer 提供变更清单、证据链与待确认设计项。
> 状态：A1b 仍未签收（NO-GO）。本材料不构成签收，仅整理当前可核验事实。
> 关联：`docs/0.4.0-EXECUTION-PROTOCOL.md`、`v0/DEVELOPMENT-STATUS.md`、`docs/0.4.0-A1B-EXISTING-STATE-MATRIX.md`。

## 1. 本轮变更清单（commit → 内容 → 验证）

| Commit | 内容 | 验证 |
|---|---|---|
| `48ca9b5` | `sameHistoryState` 改用 history 自身序列化比较；摘要分支与 `compactHistoryBinding` 字节对齐（exists 前缀字节 + 美化 JSON + 换行） | `npm test` 首次全绿（exit 0）；`verify-v0-research-apply-transaction` 12/12（原红灯测试通过） |
| `4fb80cd` | `main.js` 接入 `existingRestoreLifecycle`（`snapshotRestoreExistingRestoreLifecycle` 暴露 native existingRestore 作用域）；wiring 测试锁定 | `verify-v0-changes-history-production-wiring` 1/1 |
| `2145ee3` | EXISTING production fixture 构造真实 WRCCHRJ2 journal + `journalMarkerBinding`；request.markerDigest = binding.activeMarkerDigest | JS 侧通过冻结 wire 契约；失败点移到 C 层 |
| `8f49a6c` | **C 迁移**：EXISTING E/R wire 扩展为 33 字段（23 journal binding + artifact/selection/base-history/history-parent 权威字段）；`existing_execute_header` 重写；`existing_journal_marker_valid`（journal frame + active marker 切片 + root/recovery 身份）替代 legacy 整文件 hash；control/apply/terminal 记录改用 `active_marker_digest`；`maxJournalBindingHeaderBytes` 1024→4096 | `verify-v0-public-markdown-native-lifecycle` **67/67**（含 A1b production E）；schema 测试 23/23；全 native + changes/snapshot 套件 0 失败；`npm test` 全绿 |
| `d5c1b07` | `create-journal-lifecycle` fixture 补 `existingTerminalPublication`（KEYS.VALUE 新键） | Stage A 门禁该项通过 |
| `381abd8` | snapshot-restore fake lifecycle 补 `createMissingJournal`/`verifyCreate`/`reconcileFinalize` | Stage A 门禁 `verify-v0-snapshot-restore-service` 通过 |
| 本轮（rollback-create journal 迁移，见 §4 决策） | **ROLLBACK_CREATE 迁移到 WRCCHRJ2 journal 单权威**：① held binding 改为 journal 语义（`markerIdentity.contentSha256` = `journalFileIdentity.contentSha256`，markerByteLength = journal 文件长度，held fd = journal fd）；② rollback REQUEST 新增 `journalMarkerDigest`（held journal 整文件 sha，取自 `journalMarkerBinding.journalFileIdentity.contentSha256`），`markerDigest` 保持 EXISTING active-marker 域摘要；③ rollback wire 扩展：Q/R 30 字段、D 31 字段、A 44 字段（`journalMarkerDigest` 固定位于字段 29）；④ C `rollback_header`/`RollbackRequest` 解析 journal_digest；⑤ `rollback_held_authority` 用 `journal_digest` 对 HELD_MARKER_FD（= `changes-history-transaction.json`）整文件 hash 校验；⑥ **移除** `rollback_existing_request_digest` 重建（见 §4-1 决策） | `verify-v0-public-markdown-native-rollback-create-lifecycle` **23/23**（真实 journal fixture，含 marker-new-inode 期刊替换 CAS 拒绝）；`verify-v0-public-markdown-native-rollback-create-schema` **16/16**（冻结摘要/线长/sha256 全部更新）；Stage A 门禁 **39/39**；`npm test` exit 0 |

## 2. 证据链（边界 → 证据）

| 边界 | 证据（测试） | 级别 |
|---|---|---|
| Main 混合事务路径（Research apply → durable.review） | `verify-v0-research-apply-transaction` 12/12（`production injection commits Research` 通过） | 生产 mixed 直接服务路径 |
| Main 装配（existingRestoreLifecycle 接线） | `verify-v0-changes-history-production-wiring` | 静态装配证据 |
| native EXISTING E（journal 单权威） | `verify-v0-public-markdown-native-lifecycle` 67/67（A1b production E：真实 journal frame → active marker 切片 → COMMITTED + terminal receipt 逐字节对账） | 生产 native 边界 |
| native ROLLBACK_CREATE Q/R/D/A（journal 单权威） | `verify-v0-public-markdown-native-rollback-create-lifecycle` 23/23（真实 journal fixture；`journalMarkerDigest` 整文件 sha 锚定 HELD_MARKER_FD；marker-new-inode 替换在 R 终态/公共 rename 前/收据后三处被 CAS 拒绝） | 生产 native 边界 |
| EXISTING wire 契约 | `verify-v0-snapshot-existing-restore-native-schema` 23/23（33 字段 + sha256 冻结） | schema/wire 契约 |
| ROLLBACK_CREATE wire 契约 | `verify-v0-public-markdown-native-rollback-create-schema` 16/16（Q/R 30 / D 31 / A 44 字段；冻结摘要、线长、sha256；独立重建 wire 权威） | schema/wire 契约 |
| journal 物理帧 | `verify-v0-changes-history-marker-journal-native-lifecycle` 10/10、`marker-journal` 12/12、`marker-journal-schema` 26/26 | native 物理帧 |
| 默认套件 | `npm test` exit 0（0 失败）；Stage A 门禁 39/39 | 回归基线 |

## 3. 三条红灯当前状态

| 红灯 | 状态 |
|---|---|
| #1 journal 物理绑定单权威化 | **EXISTING E/R 路径已完成**（C wire + journal frame 校验 + active marker 切片）。**ROLLBACK_CREATE 路径本轮已完成**（§4-1 决策落地：held binding journal 语义 + wire 增 `journalMarkerDigest` + C `rollback_held_authority` 整文件 sha 锚定；两个 rollback 测试 23/23 + 16/16 全绿）。`snapshot_restore_undo` 仍 fail-closed（reconciliation:4572-4576 "not yet journal-backed"）；LEGACY 回落路径仍在（persist:4520-4540） |
| #2 Main mixed publication CAS 持久化接线 | 接线缺口已关闭（`main.js` 传入 `existingRestoreLifecycle`）。**mixed 生产纵切**（Main CAS 持久 `existingTerminalPublication` + 响应丢失协调）的证据仍未补齐 |
| #3 mixed EXISTING+MISSING 事务出口 | 测试级症状已关闭（sameHistoryState；`production injection` 通过）。**完整的 mixed 生产旅程 fault-injection 证据**未补齐 |

## 4. 待确认设计项（需 owner/合同决策，阻止机械继续）

1. **ROLLBACK_CREATE 的 marker 语义 —— 已决策（本轮落地，记录如下）**：EXISTING REQUEST 强制 `journalMarkerBinding`（markerDigest = `activeMarkerDigest` 域摘要）。rollback held binding 迁移为 journal 语义（组合原候选 A + C）：
   - `buildRollbackCreateHeldBinding` 不变式改为 `markerIdentity.contentSha256 === journalMarkerBinding.journalFileIdentity.contentSha256`（held marker = journal 文件整内容），markerByteLength = journal 文件长度，held fd = journal fd。
   - rollback REQUEST 新增 `journalMarkerDigest`（= held journal 整文件 sha）；`markerDigest` 保持 EXISTING active-marker 域摘要（C 用它重建 EXISTING control/rollback/terminal 记录）。
   - rollback wire 扩展：Q/R 30 字段、D 31 字段、A 44 字段，`journalMarkerDigest` 固定字段 29；`rollback_held_authority` 用 `journal_digest` 对 HELD_MARKER_FD（= `changes-history-transaction.json`）整文件 hash 校验。
   - **移除 `rollback_existing_request_digest` 重建**：legacy 11 字段 canonical 无法覆盖 journal binding（重建需在 rollback wire 上携带全部 binding 字段，重复 E/R 33 字段线且无新增 ground truth）；EXISTING E/R 路径从不重建请求摘要（`EXISTING_REQUEST_SCHEMA` 仅被该已删函数使用）——EXISTING 权威改由磁盘记录锚定（recordKey 嵌入 requestDigest，`rollback_existing_records` 逐字节核对 on-disk control/rollback 文件）+ held journal 整文件 sha 锚定。
2. **`snapshot_restore_undo` journal-backed**（reconciliation:4572-4576 目前 fail-closed）：需要实现完整 undo 旅程（quarantine/reconcile/finalize/ack 的 journal 状态机），是独立大切片。
3. **LEGACY 回落移除**（persist:4520-4540 `current.status !== 'LEGACY'` 才走 journal）：全部路径 journal-backed 后移除 legacy marker 文件写入。
4. **mixed 生产纵切证据**：EXISTING+MISSING 同事务的 Main CAS `existingTerminalPublication` fault-injection（响应丢失/漂移/部分记录 → 收敛判定）。

## 5. 复审者核对清单

- [ ] `npm test` 全绿（基线）
- [ ] `npm run verify:0.4:registration`（220/220）
- [ ] `verify-v0-public-markdown-native-lifecycle` 67/67（journal 单权威 EXISTING）
- [ ] `verify-v0-public-markdown-native-rollback-create-lifecycle` 23/23（journal 单权威 ROLLBACK_CREATE）
- [ ] `verify-v0-public-markdown-native-rollback-create-schema` 16/16（Q/R 30 / D 31 / A 44 字段冻结）
- [ ] `verify-v0-research-apply-transaction` 12/12（mixed 直接服务路径）
- [ ] C wire 33 字段与 `encodeExistingCommand` 逐字段核对
- [ ] rollback wire：`journalMarkerDigest`（字段 29）与 JS `rollbackCreateAuthorityHeaderFields` 逐字段核对；`rollback_held_authority` 用 `journal_digest` 校验 HELD_MARKER_FD 整文件 sha
- [ ] §4-1 决策核验：`buildRollbackCreateHeldBinding` 不变式 = journalFileIdentity.contentSha256；`rollback_existing_request_digest` 已删除（无残留引用）
- [ ] §4 剩余设计项决策后：undo journal-backed / LEGACY 移除 / mixed 纵切证据
- [ ] 本材料归档后：按执行协议绑定 clean commit 做完整 finding batch（P0/P1 清零）
