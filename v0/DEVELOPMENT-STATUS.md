# 笔触 · WritCraft 当前开发状态

> 最后更新：2026-08-17
> 当前公开/代码版本：`writ-craft@0.3.1`（npm `preview`）
> 下一目标：`0.4.0` 证据与交付闭环（`WRC-0.4.0-R1`）
> 当前 checkpoint：**Stage A / A1b mixed EXISTING + `ROLLBACK_CREATE` 开发中**
> 当前结论：**P0=0、P1=2；A1b 仍 NO-GO；A1c、A2、Stage B 重签与 Stage C/D/E 继续冻结**

## 1. 当前权威

- 产品范围：`docs/ROADMAP.md` 与 `docs/ROADMAP-0.4.0.md`。
- 执行顺序：`docs/0.4.0-EXECUTION-PROTOCOL.md`。
- A1b 状态/失败边界：`docs/0.4.0-A1B-EXISTING-STATE-MATRIX.md`。
- 当前工程事实：源码与可复现测试优先于文档快照。
- A1b 本轮提交与 component 证据汇总见
  [`docs/archive/engineering/A1B-INDEPENDENT-REVIEW-MATERIALS-2026-08-16.md`](../docs/archive/engineering/A1B-INDEPENDENT-REVIEW-MATERIALS-2026-08-16.md)；它不是签收记录，也不拥有派工权。

## 2. 已完成边界

- **A0** 与 **A1a** 已签收；A1b primary E 与 E3 pure journal authority 保留其既有窄层独立证据。
- `dcc197c` 前后的 A1b 实现已完成 WRCCHRJ2 journal 单权威 E/R wire、native
  `ROLLBACK_CREATE` Q/R/D/A、Main post-E terminal CAS，以及 mixed applied 主线：
  `PRECREATE → CREATED_RECEIPT → EXISTING_COMMITTED → HISTORY_COMMITTED → FINALIZED → ACK_COMMITTED → IDLE`。
- 以上是 A1b implementation/component evidence，不代表完整 rollback 出口或 A1b checkpoint 已签收。

## 3. 当前两个 P1

1. **Fresh R publication-time identity 未闭合**：`WRC_A1B_E3_R=1` 的
   `control new-inode-exact` 场景仍把同内容新 inode 接受为 `COMMITTED`，预期必须是
   `UNKNOWN`。R 不能从当前 control record 重铸 publication-time identity。
2. **Main formal rollback 出口未接通**：native `ROLLBACK_CREATE` Q/R/D/A 已有组件证据，
   但 Main mixed 事务尚未把 EXISTING formal `UNCOMMITTED` 编排为
   `Q → fresh R → D → A` 并证明所有 EXISTING/MISSING leaf 与 raw History 回到 operation-before。

没有已知 P0。Mixed applied 成功出口、journal physical binding 与 post-E CAS 不再列为开放红灯。
`snapshot_restore_undo` journal-backed 属 A1c；LEGACY 移除属于后续迁移；Main/handler App 接线属于 A2，均不扩大本次 A1b 阻断清单。

## 4. 当前可复现证据

- `node tests/check-v0-0-4-test-registration.js --check`：221 scripts，52 current，40 Stage A，exit 0。
- `node tests/verify-v0-snapshot-restore-mixed-journey.js`：4/4，exit 0。
- `node tests/verify-v0-snapshot-restore-service.js`：41/41，exit 0。
- `node tests/verify-v0-public-markdown-native-lifecycle.js`：67/67，exit 0。
- `node tests/verify-v0-public-markdown-native-rollback-create-lifecycle.js`：exit 0。
- `WRC_A1B_E3_R=1 node tests/verify-v0-public-markdown-native-lifecycle.js`：在
  `control new-inode-exact` 首红，actual `COMMITTED` / expected `UNKNOWN`。

Focused、schema、native 或 direct-service 绿灯不能覆盖该首红，也不能替代完整 A1b 独立复审。

## 5. 唯一下一动作

**关闭上述两个 P1，补真实 formal mixed rollback production journey，形成一个 clean local A1b checkpoint commit/tree，再启动一次完整独立复审。**

A1b 签收前，A1c、A2a–A2d、A3、A→B、Stage C/D/E、candidate、push/tag/release/publish/distribution 均冻结。

## 6. 门禁执行清单（无 CI 时的显式步骤）

- `npm run verify:syntax`
- `npm run verify:0.4:registration`
- `npm run verify:0.4:current-components`
- `npm test` / `npm run verify`

CI（`.github/workflows/verify.yml`）按 registration → syntax → current-components → test →
`npm audit --omit=dev` 编排；完整数字只在当前 checkpoint 出口重跑后更新。
