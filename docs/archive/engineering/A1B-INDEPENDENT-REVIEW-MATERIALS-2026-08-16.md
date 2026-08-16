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

## 2. 证据链（边界 → 证据）

| 边界 | 证据（测试） | 级别 |
|---|---|---|
| Main 混合事务路径（Research apply → durable.review） | `verify-v0-research-apply-transaction` 12/12（`production injection commits Research` 通过） | 生产 mixed 直接服务路径 |
| Main 装配（existingRestoreLifecycle 接线） | `verify-v0-changes-history-production-wiring` | 静态装配证据 |
| native EXISTING E（journal 单权威） | `verify-v0-public-markdown-native-lifecycle` 67/67（A1b production E：真实 journal frame → active marker 切片 → COMMITTED + terminal receipt 逐字节对账） | 生产 native 边界 |
| EXISTING wire 契约 | `verify-v0-snapshot-existing-restore-native-schema` 23/23（33 字段 + sha256 冻结） | schema/wire 契约 |
| journal 物理帧 | `verify-v0-changes-history-marker-journal-native-lifecycle` 10/10、`marker-journal` 12/12、`marker-journal-schema` 26/26 | native 物理帧 |
| 默认套件 | `npm test` exit 0（0 失败） | 回归基线 |

## 3. 三条红灯当前状态

| 红灯 | 状态 |
|---|---|
| #1 journal 物理绑定单权威化 | **EXISTING E/R 路径已完成**（C wire + journal frame 校验 + active marker 切片）。**ROLLBACK_CREATE 路径未完成**（见 §4 设计缺口）。`snapshot_restore_undo` 仍 fail-closed（reconciliation:4572-4576 "not yet journal-backed"）；LEGACY 回落路径仍在（persist:4520-4540） |
| #2 Main mixed publication CAS 持久化接线 | 接线缺口已关闭（`main.js` 传入 `existingRestoreLifecycle`）。**mixed 生产纵切**（Main CAS 持久 `existingTerminalPublication` + 响应丢失协调）的证据仍未补齐 |
| #3 mixed EXISTING+MISSING 事务出口 | 测试级症状已关闭（sameHistoryState；`production injection` 通过）。**完整的 mixed 生产旅程 fault-injection 证据**未补齐 |

## 4. 待确认设计项（需 owner/合同决策，阻止机械继续）

1. **ROLLBACK_CREATE 的 marker 语义**：EXISTING REQUEST 已强制 `journalMarkerBinding`（markerDigest = `activeMarkerDigest` 域摘要），但 `ROLLBACK_CREATE_HELD_BINDING`（public-markdown-native-schema:306-310）仍要求 `markerIdentity.contentSha256 === request.markerDigest`——journal 文件内容哈希 ≠ 域摘要，**二者在 journal 模型下不可能同时成立**。`verify-v0-public-markdown-native-rollback-create-lifecycle/schema` 因此为既有红灯。
   候选方案：
   - A：rollback held binding 改为 journal 语义（markerIdentity.contentSha256 = activeMarkerCanonicalSha256、markerByteLength = active marker 切片长度、marker fd = journal fd）+ C `rollback_held_authority` 同步 journal 化。
   - B：rollback-create 维持独立 legacy marker 文件（与 journal 并存）——需在 EXISTING request 的 markerDigest 语义上解耦（违背单权威意图）。
   - C：rollback wire 扩展携带 journal binding（同 EXISTING 33 字段模式）。
2. **`snapshot_restore_undo` journal-backed**（reconciliation:4572-4576 目前 fail-closed）：需要实现完整 undo 旅程（quarantine/reconcile/finalize/ack 的 journal 状态机），是独立大切片。
3. **LEGACY 回落移除**（persist:4520-4540 `current.status !== 'LEGACY'` 才走 journal）：全部路径 journal-backed 后移除 legacy marker 文件写入。
4. **mixed 生产纵切证据**：EXISTING+MISSING 同事务的 Main CAS `existingTerminalPublication` fault-injection（响应丢失/漂移/部分记录 → 收敛判定）。

## 5. 复审者核对清单

- [ ] `npm test` 全绿（基线）
- [ ] `npm run verify:0.4:registration`（220/220）
- [ ] `verify-v0-public-markdown-native-lifecycle` 67/67（journal 单权威 EXISTING）
- [ ] `verify-v0-research-apply-transaction` 12/12（mixed 直接服务路径）
- [ ] C wire 33 字段与 `encodeExistingCommand` 逐字段核对
- [ ] `existing_journal_marker_valid` 的 frame/marker/身份校验与 JS binding 派生逐字节对账
- [ ] §4 设计项决策后：rollback-create / undo journal-backed / LEGACY 移除 / mixed 纵切证据
- [ ] 本材料归档后：按执行协议绑定 clean commit 做完整 finding batch（P0/P1 清零）
