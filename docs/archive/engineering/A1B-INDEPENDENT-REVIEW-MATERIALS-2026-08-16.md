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
| `a835a07`（mixed 生产纵切证据，见 §4-5） | **Main mixed 生产纵切**：① reconciliation 新增 `reconcileExistingRestore`（native R 重建终端 + journal CAS）并暴露 `reconcile`（`existingLifecycleFor`），transaction 新增包装；② `executeExistingRestore`/`reconcileExistingRestore` 合并为 `runExistingRestore(rootPath, projectId, operationId, command)`；held descriptors 契约修正（`markerFd` = journal fd，原传 `journalFd` 与 lifecycle 契约不符）；③ `snapshot-restore-service` mixed 编排落地（原 `SNAPSHOT_RESTORE_MIXED_SELECTION_UNAVAILABLE` 拒绝 → `runMixedJourney`）；④ **C EXISTING R dispatch 修复**：`existing_reconcile_header_shape` 15→33 字段（原 33 字段 R wire 落入 CREATE 语法 → status 3 → R 不可达）；⑤ `commitMissingRestoreHistoryJournal` 接受 `EXISTING_COMMITTED` 入口 phase；⑥ `precreatePhaseDigest` PRECREATE 重建清零 `existingReceiptSetDigest`/`rollbackReceiptDigest`；⑦ R 路径 before-leaf 摘要从磁盘 control record 恢复（`existingControlBeforeLeafDigest`） | **新测试 `verify-v0-snapshot-restore-mixed-journey` 3/3**（真实 helper + 真实 journal + 真实 Main transaction，无 fake adapter）：① mixed journey CAS-installs existingTerminalPublication；② lost EXISTING response → executeExistingRestore fail-closed → `reconcileExistingRestore`（fresh native R）收敛并 CAS 安装同一 terminal publication（E 不重放）；③ journal 在 EXISTING terminal CAS 前漂移 → fail-closed（publication 未安装、CREATE 侧保持、可恢复 UNKNOWN）。Stage A 门禁 **40/40**；`npm test` exit 0 |
| `8912b8e`（service 编排覆盖） | `snapshot-restore-service.runMixedJourney` 顺序修正（MISSING CREATE 先到 CREATED_RECEIPT，EXISTING 后；applied 结果携带 operationId 与精确 applied/recovered 键形状）；`verify-v0-snapshot-restore-service` 增 mixed 全旅程调用序测试 + lost-EXISTING 响应测试 | **41/41**；`npm test` exit 0 |
| `a1db6f9`（EXISTING finalize/ack 原生切片，见 §4-5） | **C EXISTING finalize(F) + ack(A)**：`existing_finalize` 将 CAS-installed terminal 密封为 owner-private final record（`.changes-history-native-existing-final.<hex>`，0600/nlink 1，重建 FINAL_RECORD canonical 并捕获精确身份）；`existing_ack` 校验 final record 仍为精确密封文件并确认；dispatch `F\tPUBLISH`/`F\tACK`（与 CREATE finalize 的 `F\t<operationId>` 区分），itemCount 0 fail-closed；JS `parseFinalizeResponse`/`parseAckResponse` 校验 envelope、重建 FINAL_RECORD、绑定身份；lifecycle `finalizeExisting`/`ackExisting` 解析 COMMITTED 响应 | **E-4 门禁（`WRC_A1B_E4_FA=1`）2/2**：finalize 密封 + ACK 确认精确记录；空 terminal wire 拒绝。`npm test` exit 0；helper 重建 |

## 2. 证据链（边界 → 证据）

| 边界 | 证据（测试） | 级别 |
|---|---|---|
| Main 混合事务路径（Research apply → durable.review） | `verify-v0-research-apply-transaction` 12/12（`production injection commits Research` 通过） | 生产 mixed 直接服务路径 |
| Main 装配（existingRestoreLifecycle 接线） | `verify-v0-changes-history-production-wiring` | 静态装配证据 |
| native EXISTING E（journal 单权威） | `verify-v0-public-markdown-native-lifecycle` 67/67（A1b production E：真实 journal frame → active marker 切片 → COMMITTED + terminal receipt 逐字节对账） | 生产 native 边界 |
| native ROLLBACK_CREATE Q/R/D/A（journal 单权威） | `verify-v0-public-markdown-native-rollback-create-lifecycle` 23/23（真实 journal fixture；`journalMarkerDigest` 整文件 sha 锚定 HELD_MARKER_FD；marker-new-inode 替换在 R 终态/公共 rename 前/收据后三处被 CAS 拒绝） | 生产 native 边界 |
| **Main mixed 生产纵切（无 fake adapter）** | **`verify-v0-snapshot-restore-mixed-journey` 3/3**（真实 public-markdown + changes-history-artifact helper、真实 Main transaction/reconciliation：① mixed CAS 持久 existingTerminalPublication；② lost E response → fresh native R 收敛 + CAS 安装；③ journal 漂移 fail-closed） | 生产 mixed 直接服务路径 |
| EXISTING wire 契约 | `verify-v0-snapshot-existing-restore-native-schema` 23/23（33 字段 + sha256 冻结） | schema/wire 契约 |
| ROLLBACK_CREATE wire 契约 | `verify-v0-public-markdown-native-rollback-create-schema` 16/16（Q/R 30 / D 31 / A 44 字段；冻结摘要、线长、sha256；独立重建 wire 权威） | schema/wire 契约 |
| journal 物理帧 | `verify-v0-changes-history-marker-journal-native-lifecycle` 10/10、`marker-journal` 12/12、`marker-journal-schema` 26/26 | native 物理帧 |
| 默认套件 | `npm test` exit 0（0 失败）；Stage A 门禁 39/39 | 回归基线 |

## 3. 三条红灯当前状态

| 红灯 | 状态 |
|---|---|
| #1 journal 物理绑定单权威化 | **EXISTING E/R 路径已完成**（C wire + journal frame 校验 + active marker 切片）。**ROLLBACK_CREATE 路径已完成**（§4-1 决策落地；23/23 + 16/16 全绿）。`snapshot_restore_undo` 仍 fail-closed（reconciliation:4572-4576 "not yet journal-backed"）；LEGACY 回落路径仍在（persist:4520-4540） |
| #2 Main mixed publication CAS 持久化接线 | **生产纵切证据已补齐（§4-5）**：`verify-v0-snapshot-restore-mixed-journey` 3/3——真实 helper + 真实 journal，mixed CAS 持久 `existingTerminalPublication`（COMMITTED）、lost E response 经 fresh native R 收敛、journal 漂移 fail-closed。遗留：snapshot-restore-service 的 mixed 编排已实现但**未接入 main.js/handler**（该服务本身未接线，独立接线切片） |
| #3 mixed EXISTING+MISSING 事务出口 | 测试级症状已关闭（sameHistoryState；`production injection` 通过）。mixed journey 到 **EXISTING_COMMITTED** 的证据已补齐（§4-5）。**完整出口进行中**：C EXISTING finalize/ack 原生切片已完成（`a1db6f9`，E-4 门禁 2/2）；Main mixed finalization（authority 复用抽取 + terminal receipt 自 publication 重建 + EXISTING_FINALIZATION 转移 + CAS）为下一切片 |

## 4. 待确认设计项（需 owner/合同决策，阻止机械继续）

1. **ROLLBACK_CREATE 的 marker 语义 —— 已决策（本轮落地，记录如下）**：EXISTING REQUEST 强制 `journalMarkerBinding`（markerDigest = `activeMarkerDigest` 域摘要）。rollback held binding 迁移为 journal 语义（组合原候选 A + C）：
   - `buildRollbackCreateHeldBinding` 不变式改为 `markerIdentity.contentSha256 === journalMarkerBinding.journalFileIdentity.contentSha256`（held marker = journal 文件整内容），markerByteLength = journal 文件长度，held fd = journal fd。
   - rollback REQUEST 新增 `journalMarkerDigest`（= held journal 整文件 sha）；`markerDigest` 保持 EXISTING active-marker 域摘要（C 用它重建 EXISTING control/rollback/terminal 记录）。
   - rollback wire 扩展：Q/R 30 字段、D 31 字段、A 44 字段，`journalMarkerDigest` 固定字段 29；`rollback_held_authority` 用 `journal_digest` 对 HELD_MARKER_FD（= `changes-history-transaction.json`）整文件 hash 校验。
   - **移除 `rollback_existing_request_digest` 重建**：legacy 11 字段 canonical 无法覆盖 journal binding（重建需在 rollback wire 上携带全部 binding 字段，重复 E/R 33 字段线且无新增 ground truth）；EXISTING E/R 路径从不重建请求摘要（`EXISTING_REQUEST_SCHEMA` 仅被该已删函数使用）——EXISTING 权威改由磁盘记录锚定（recordKey 嵌入 requestDigest，`rollback_existing_records` 逐字节核对 on-disk control/rollback 文件）+ held journal 整文件 sha 锚定。
2. **`snapshot_restore_undo` journal-backed**（reconciliation:4572-4576 目前 fail-closed）：需要实现完整 undo 旅程（quarantine/reconcile/finalize/ack 的 journal 状态机），是独立大切片。
3. **LEGACY 回落移除**（persist:4520-4540 `current.status !== 'LEGACY'` 才走 journal）：全部路径 journal-backed 后移除 legacy marker 文件写入。
4. **mixed 生产纵切 —— 已补齐（本轮，见 §2 证据链）**：`verify-v0-snapshot-restore-mixed-journey` 3/3（真实边界 fault-injection：CAS 持久 / 响应丢失 / journal 漂移）。
5. **mixed 事务出口 —— 原生切片已完成（`a1db6f9`），Main 切片为下一轮**：journey 现止于 EXISTING_COMMITTED（terminal publication CAS-installed）。已落地：
   - **C EXISTING `finalize`/`ack`**（`a1db6f9`）：`existing_finalize` 密封 terminal（重建 FINAL_RECORD canonical、写 owner-private final record、捕获身份）；`existing_ack` 校验 final record 并确认；dispatch 与 CREATE finalize 区分；JS 解析器 + lifecycle 接线；E-4 门禁 2/2。
   - 下一片 Main `finalizeMissingRestore` 的 mixed 分支：① 从 `runExistingRestore` 抽取 authority/descriptors 上下文构建（放开 phase 到 EXISTING_COMMITTED）；② terminal receipt 自 `existingTerminalPublication` 重建（apply token = controlBasename/applyBasename/controlDigest/applyReceiptDigest/controlRecordIdentity/applyRecordIdentity + afterLeafIdentityDigest = digestExistingLeafIdentity(finalLeafIdentity, request item binding)，terminalReceiptDigest 必须与 publication 匹配）；③ `lifecycle.finalize` → `EXISTING_FINALIZATION`（finalizeRequestDigest/historyCommittedPhaseDigest/finalBasename/finalRecordDigest/finalRecordIdentity/markerFinalizedPhaseDigest）→ publication COMMITTED→FINALIZED 转移 + journal CAS。
   - 遗留：E-3 门禁（`WRC_A1B_E3_R`）经 dispatch 修复后 fresh R 路径 6/7 通过，剩 **control new-inode-exact** 漂移检测缺口（R 对"同内容新 inode"的 control record 接受为 COMMITTED——身份锚定需设计决策）。
6. **snapshot-restore-service 接线到 main.js/handler**：mixed 编排已在服务层落地（本轮），但 `createSnapshotRestoreService` 尚未被 main.js/handler 引用（独立接线切片）。

## 5. 复审者核对清单

- [ ] `npm test` 全绿（基线）
- [ ] `npm run verify:0.4:registration`（221/221，40 Stage A current）
- [ ] `verify-v0-public-markdown-native-lifecycle` 67/67（journal 单权威 EXISTING）
- [ ] `verify-v0-public-markdown-native-rollback-create-lifecycle` 23/23（journal 单权威 ROLLBACK_CREATE）
- [ ] `verify-v0-public-markdown-native-rollback-create-schema` 16/16（Q/R 30 / D 31 / A 44 字段冻结）
- [ ] **`verify-v0-snapshot-restore-mixed-journey` 3/3（真实 helper + 真实 journal + 真实 Main transaction，无 fake adapter）**
- [ ] `verify-v0-research-apply-transaction` 12/12（mixed 直接服务路径）
- [ ] C wire 33 字段与 `encodeExistingCommand` 逐字段核对
- [ ] rollback wire：`journalMarkerDigest`（字段 29）与 JS `rollbackCreateAuthorityHeaderFields` 逐字段核对；`rollback_held_authority` 用 `journal_digest` 校验 HELD_MARKER_FD 整文件 sha
- [ ] §4-1 决策核验：`buildRollbackCreateHeldBinding` 不变式 = journalFileIdentity.contentSha256；`rollback_existing_request_digest` 已删除（无残留引用）
- [ ] §4-5 核验：`reconcileExistingRestore`（fresh native R + CAS）、`existing_reconcile_header_shape` 33 字段 dispatch、`existingControlBeforeLeafDigest`（R 路径 before-leaf 从 control record 恢复）、snapshot-restore-service `runMixedJourney`
- [ ] §4 剩余设计项决策后：mixed 出口（EXISTING finalize/ack + EXISTING_FINALIZATION 转移）/ undo journal-backed / LEGACY 移除 / service 接线
- [ ] 本材料归档后：按执行协议绑定 clean commit 做完整 finding batch（P0/P1 清零）
