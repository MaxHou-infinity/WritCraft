# A1b 独立复审材料（2026-08-16）

> 目的：为 A1b mixed EXISTING + `ROLLBACK_CREATE` 的独立 reviewer 提供变更清单、证据链与当前开放项。
> 状态（2026-08-16 当时）：A1b 仍未签收（NO-GO）。本材料不构成签收，仅整理当时可核验事实。
> **后续更新（2026-09-12 补注）**：A1b 已于 `1f43b7f` 由同一 reviewer 定点确认 **GO（P0=0、P1=0、P2=2）**，
> 见 [`docs/0.4.0-A1B-INDEPENDENT-REVIEW.md`](../../0.4.0-A1B-INDEPENDENT-REVIEW.md) 文末与 `v0/DEVELOPMENT-STATUS.md`。
> 本文件保持归档原貌，不再代表当前状态。
> 关联：`docs/0.4.0-EXECUTION-PROTOCOL.md`、`v0/DEVELOPMENT-STATUS.md`、`docs/0.4.0-A1B-EXISTING-STATE-MATRIX.md`。

## 1. 本轮变更清单（commit → 内容 → 验证）

| Commit | 内容 | 验证 |
|---|---|---|
| `48ca9b5` | `sameHistoryState` 改用 history 自身序列化比较；摘要分支与 `compactHistoryBinding` 字节对齐（exists 前缀字节 + 美化 JSON + 换行） | `npm test` 首次全绿（exit 0）；`verify-v0-research-apply-transaction` 12/12（原红灯测试通过） |
| `4fb80cd` | `main.js` 接入 `existingRestoreLifecycle`（`snapshotRestoreExistingRestoreLifecycle` 暴露 native existingRestore 作用域）；wiring 测试锁定 | `verify-v0-changes-history-production-wiring` 1/1 |
| `2145ee3` | EXISTING production fixture 构造真实 WRCCHRJ2 journal + `journalMarkerBinding`；request.markerDigest = binding.activeMarkerDigest | JS 侧通过冻结 wire 契约；失败点移到 C 层 |
| `8f49a6c` | **C 迁移**：EXISTING E/R wire 扩展为 33 字段（23 journal binding + artifact/selection/base-history/history-parent 权威字段）；`existing_execute_header` 重写；`existing_journal_marker_valid`（journal frame + active marker 切片 + root/recovery 身份）替代 legacy 整文件 hash；control/apply/terminal 记录改用 `active_marker_digest`；`maxJournalBindingHeaderBytes` 1024→4096 | `verify-v0-public-markdown-native-lifecycle` **67/67**（含 A1b production E）；schema 测试 23/23；全 native + changes/snapshot 套件 0 失败；`npm test` 全绿 |
| `d5c1b07` | `create-journal-lifecycle` fixture 补 `existingTerminalPublication`（KEYS.VALUE 新键） | Stage A 门禁该项通过 |
| `3f0208b` | 建立本 A1b 独立复审材料，汇总当时提交、证据链与开放设计项 | 文档记录；不构成签收 |
| `381abd8` | snapshot-restore fake lifecycle 补 `createMissingJournal`/`verifyCreate`/`reconcileFinalize` | Stage A 门禁 `verify-v0-snapshot-restore-service` 通过 |
| `16b6614` | **ROLLBACK_CREATE 迁移到 WRCCHRJ2 journal 单权威**：held binding 改为 journal 语义；request/wire 增 `journalMarkerDigest`；C 按 held journal 整文件 SHA 校验；删除无法覆盖 journal binding 的 legacy request-digest 重建 | rollback lifecycle 与 schema 门禁全绿；Stage A 门禁与 `npm test` exit 0；当前注册数统一见 §2 的 40 项 |
| `a835a07`（mixed 生产纵切证据，见 §4） | **Main mixed 生产纵切**：① reconciliation 新增 `reconcileExistingRestore`（native R 重建终端 + journal CAS）并暴露 `reconcile`（`existingLifecycleFor`），transaction 新增包装；② `executeExistingRestore`/`reconcileExistingRestore` 合并为 `runExistingRestore(rootPath, projectId, operationId, command)`；held descriptors 契约修正（`markerFd` = journal fd，原传 `journalFd` 与 lifecycle 契约不符）；③ `snapshot-restore-service` mixed 编排落地（原 `SNAPSHOT_RESTORE_MIXED_SELECTION_UNAVAILABLE` 拒绝 → `runMixedJourney`）；④ **C EXISTING R dispatch 修复**：`existing_reconcile_header_shape` 15→33 字段（原 33 字段 R wire 落入 CREATE 语法 → status 3 → R 不可达）；⑤ `commitMissingRestoreHistoryJournal` 接受 `EXISTING_COMMITTED` 入口 phase；⑥ `precreatePhaseDigest` PRECREATE 重建清零 `existingReceiptSetDigest`/`rollbackReceiptDigest`；⑦ R 路径 before-leaf 摘要从磁盘 control record 恢复（`existingControlBeforeLeafDigest`） | 新增真实 helper + journal + Main transaction 三项边界证据，随后由 `dcc197c` 扩展为当前 **4/4**；当时 Stage A **40/40**、`npm test` exit 0 |
| `8912b8e`（service 编排覆盖） | `snapshot-restore-service.runMixedJourney` 顺序修正（MISSING CREATE 先到 CREATED_RECEIPT，EXISTING 后；applied 结果携带 operationId 与精确 applied/recovered 键形状）；`verify-v0-snapshot-restore-service` 增 mixed 全旅程调用序测试 + lost-EXISTING 响应测试 | **41/41**；`npm test` exit 0 |
| `f18d1b3` | 将 mixed production journey 的初始三项证据写入本材料；当前证据已由后续提交扩展为 4/4 | 文档记录；不构成签收 |
| `a1db6f9`（EXISTING finalize/ack 原生切片，见 §4） | **C EXISTING finalize(F) + ack(A)**：`existing_finalize` 将 CAS-installed terminal 密封为 owner-private final record（`.changes-history-native-existing-final.<hex>`，0600/nlink 1，重建 FINAL_RECORD canonical 并捕获精确身份）；`existing_ack` 校验 final record 仍为精确密封文件并确认；dispatch `F\tPUBLISH`/`F\tACK`（与 CREATE finalize 的 `F\t<operationId>` 区分），itemCount 0 fail-closed；JS `parseFinalizeResponse`/`parseAckResponse` 校验 envelope、重建 FINAL_RECORD、绑定身份；lifecycle `finalizeExisting`/`ackExisting` 解析 COMMITTED 响应 | **E-4 门禁（`WRC_A1B_E4_FA=1`）2/2**：finalize 密封 + ACK 确认精确记录；空 terminal wire 拒绝。`npm test` exit 0；helper 重建 |
| `a79c895` | 记录 EXISTING finalize/ack 组件证据和 Main mixed applied 出口设计 | 文档记录；不构成签收 |
| `dcc197c` | **Main mixed applied finalization**：publication 驱动 F/A；publication COMMITTED→FINALIZED 与 marker FINALIZED 同次 append；ACK_COMMITTED 后 mixed cleanup 回 IDLE；修正 final-record raw SHA 与 domain digest 的错误等同约束 | mixed production journey **4/4**；journal schema 26/26；E-4 门禁 69 项；当时 Stage A 40/40、`npm test` exit 0 |

## 2. 证据链（边界 → 证据）

| 边界 | 证据（测试） | 级别 |
|---|---|---|
| Main 混合事务路径（Research apply → durable.review） | `verify-v0-research-apply-transaction` 12/12（`production injection commits Research` 通过） | 生产 mixed 直接服务路径 |
| Main 装配（existingRestoreLifecycle 接线） | `verify-v0-changes-history-production-wiring` | 静态装配证据 |
| native EXISTING E（journal 单权威） | `verify-v0-public-markdown-native-lifecycle` 67/67（A1b production E：真实 journal frame → active marker 切片 → COMMITTED + terminal receipt 逐字节对账） | 生产 native 边界 |
| native ROLLBACK_CREATE Q/R/D/A（journal 单权威） | `verify-v0-public-markdown-native-rollback-create-lifecycle` exit 0（真实 journal fixture；`journalMarkerDigest` 整文件 sha 锚定 HELD_MARKER_FD；marker-new-inode 替换在 R 终态/公共 rename 前/收据后三处被 CAS 拒绝） | 生产 native 边界 |
| **Main mixed applied 生产纵切（无 fake adapter）** | **`verify-v0-snapshot-restore-mixed-journey` 4/4**（真实 public-markdown + changes-history-artifact helper、真实 Main transaction/reconciliation：terminal CAS、lost-E fresh R、F/ACK/IDLE、journal drift fail-closed） | 生产 mixed applied 直接服务路径；不覆盖 formal UNCOMMITTED rollback 出口 |
| EXISTING wire 契约 | `verify-v0-snapshot-existing-restore-native-schema` 23/23（33 字段 + sha256 冻结） | schema/wire 契约 |
| ROLLBACK_CREATE wire 契约 | `verify-v0-public-markdown-native-rollback-create-schema` 16/16（Q/R 30 / D 31 / A 44 字段；冻结摘要、线长、sha256；独立重建 wire 权威） | schema/wire 契约 |
| journal 物理帧 | `verify-v0-changes-history-marker-journal-native-lifecycle` 10/10、`marker-journal` 12/12、`marker-journal-schema` 26/26 | native 物理帧 |
| 当前定向复现 | registration 221（52 current / 40 Stage A）；mixed 4/4；service 41/41；native 67/67；rollback lifecycle exit 0 | 当前 component/integration 基线；不覆盖下述 E3_R 首红 |

## 3. 三条红灯当前状态

| 红灯 | 状态 |
|---|---|
| #1 journal 物理绑定单权威化 | **已关闭**：`WRC_A1B_E3_R=1` 78/78 全绿；fresh R 从 stored publication 读取 control/apply publication-time identity 并以 `same_file` 校验，同内容新 inode 返回 `UNKNOWN`，不再从当前 record 重铸。 |
| #2 Main mixed publication CAS 持久化接线 | **已完成**：真实 helper + journal 已证明 terminal CAS、lost-E fresh R、old/new head drift fail-closed。Main/handler App 暴露归 A2，不作为本 A1b 后端红灯。 |
| #3 mixed EXISTING+MISSING 事务出口 | **成功出口 + formal rollback 出口均已完成**：6/6 mixed journey 证明 `PRECREATE→CREATE→EXISTING_COMMITTED→HISTORY_COMMITTED→FINALIZED→ACK_COMMITTED→IDLE`，以及 formal EXISTING `UNCOMMITTED` → `ROLLBACK_CREATE Q→fresh R→D→A→ROLLED_BACK`（真实 native D/A 实现，零 public mutation）。 |

## 4. 当前开放项与后续归属

### 4.1 A1b 两个 P1 —— 均已关闭

1. **Fresh R identity**（00c6276 已提交）：R 消费 E 时持久化的 control publication identity；同内容新 inode、same-inode rewrite 或缺失 identity 均为 `UNKNOWN`，不从当前记录重铸。`WRC_A1B_E3_R=1` 78/78。
2. **Formal mixed rollback**（本轮 P1-2，未提交 → 随本 checkpoint commit）：Main 只在 formal EXISTING `UNCOMMITTED` 后进入已冻结的 `ROLLBACK_CREATE` domain，按 Q/fresh-R/D/A 收敛并证明所有 selected public leaf 与 raw History 精确回到 operation-before。native C 补充 D/A 实现：D 仅删除精确 quarantine identity 并写 final record（FINALIZED + final identity），A 校验 ROLLED_BACK phase 后清理私有记录（ACKED）；任何不明状态保持 journal/residue。

### 4.2 已决策/已完成的 A1b 组件

- `16b6614` 已冻结 rollback journal held binding、`journalMarkerDigest` 与 Q/R/D/A wire；不再重开 marker 语义决策。
- `dcc197c` 已完成 publication-driven F/A、EXISTING finalization、ACK_COMMITTED 与 applied cleanup/IDLE；不再把 applied mixed 出口列为待决策项。
- 本轮 P1-2（Main 编排 + native D/A）：formalRollbackCreate 在 EXISTING `UNCOMMITTED` terminal 上重建 CREATE publication、held binding、precreate phase，执行 Q（失败走 fresh R）→ D → A，marker 到 `ROLLED_BACK` 并 CAS journal；C helper 补 rollback_delete/rollback_ack、dual digest scheme（journal OBJECT + legacy CREATED_SCHEMA）、restored-leaf before_revision 修正。

### 4.3 不属于 A1b 的后续工作

- `snapshot_restore_undo` journal-backed 属 **A1c**。
- snapshot restore service 的 Main/handler/IPC/Renderer 暴露属 **A2 App 接线**。
- LEGACY 回落移除在全部对应 journal-backed 路径完成后单独迁移，不作为当前 A1b 出口 blocker。

## 5. 复审者核对清单

- [ ] `npm test` 全绿（基线）
- [ ] `npm run verify:0.4:registration`（221 scripts，52 current，40 Stage A current）
- [ ] `verify-v0-public-markdown-native-lifecycle` 67/67（journal 单权威 EXISTING）
- [ ] `WRC_A1B_E3_R=1 verify-v0-public-markdown-native-lifecycle` 78/78（fresh R publication identity）
- [ ] `WRC_A1B_E4_FA=1 verify-v0-public-markdown-native-lifecycle` 69/69（EXISTING finalize/ack）
- [ ] `WRC_A1B_E2B_CONTROL=1 WRC_A1B_E2B_STAGE=1 WRC_A1B_E2B_APPLY=1 verify-v0-public-markdown-native-lifecycle` 89/89（self-rollback/UNCOMMITTED）
- [ ] `verify-v0-public-markdown-native-rollback-create-lifecycle` exit 0（journal 单权威 ROLLBACK_CREATE Q/R/D/A）
- [ ] `verify-v0-public-markdown-native-rollback-create-schema` 16/16（Q/R 30 / D 31 / A 44 字段冻结）
- [ ] **`verify-v0-snapshot-restore-mixed-journey` 6/6（真实 helper + 真实 journal + 真实 Main transaction，无 fake adapter；含 formal rollback Q/R/D/A→ROLLED_BACK）**
- [ ] `verify-v0-research-apply-transaction` 12/12（mixed 直接服务路径）
- [ ] C wire 33 字段与 `encodeExistingCommand` 逐字段核对
- [ ] rollback wire：`journalMarkerDigest`（字段 29）与 JS `rollbackCreateAuthorityHeaderFields` 逐字段核对；`rollback_held_authority` 用 `journal_digest` 校验 HELD_MARKER_FD 整文件 sha
- [ ] §4.2 rollback journal binding 核验：`buildRollbackCreateHeldBinding` 不变式 = journalFileIdentity.contentSha256；`rollback_existing_request_digest` 已删除（无残留引用）
- [ ] §4 applied 核验：`reconcileExistingRestore`（fresh native R + CAS）、33 字段 R dispatch、publication-driven F/A、snapshot-restore-service `runMixedJourney`
- [ ] **native D/A 核验**：`rollback_delete` 仅删除精确 quarantine identity 并写 final record；`rollback_ack` 校验 final identity + ROLLED_BACK phase 后清理；`rollback_missing_public_state`/`rollback_quarantine_one` 同时接受 journal OBJECT 与 legacy CREATED_SCHEMA created digest
- [ ] 本材料归档后：按执行协议绑定 clean commit 做完整 finding batch（P0/P1 清零）
