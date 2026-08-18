# 笔触 · WritCraft 当前开发状态

> 最后更新：2026-08-17
> 当前公开/代码版本：`writ-craft@0.3.1`（npm `preview`）
> 下一目标：`0.4.0` 证据与交付闭环（`WRC-0.4.0-R1`）
> 当前 checkpoint：**Stage A / A1b mixed EXISTING + `ROLLBACK_CREATE` 实现完成，待独立复审**
> 当前结论：**P0=0、P1=0；A1b 需一次完整独立复审后签收；A1c、A2、Stage B 重签与 Stage C/D/E 继续冻结**

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
- 两个 P1 已关闭：fresh R 绑定 stored publication identity（`WRC_A1B_E3_R` 全绿），
  Main 已把 EXISTING formal `UNCOMMITTED` 编排为 `Q → fresh R → D → A → ROLLED_BACK`
  （真实 native production mixed journey，6/6 全绿，零 public mutation）。
- 以上是 A1b implementation/component evidence；checkpoint 签收仍需一次完整独立复审（P0/P1=0）。

## 3. 当前 P1

两个 A1b P1 均已关闭：

1. **Fresh R publication-time identity 已闭合**：`WRC_A1B_E3_R=1` 全绿；R 从 stored
   publication 读取 control/apply identity 并以 `same_file` 校验，同内容新 inode 返回
   `UNKNOWN`，不再从当前 record 重铸 publication-time identity。
2. **Main formal rollback 出口已接通**：native E apply 失败后 self-rollback 到 formal
   EXISTING `UNCOMMITTED`，Main 编排 `Q → fresh R → D → A`，D 仅删除精确 quarantine
   identity 并写 final record，A 校验 ROLLED_BACK phase 后清理私有记录；marker 到达
   `ROLLED_BACK`，所有 EXISTING/MISSING leaf 与 raw History 回到 operation-before。

没有已知 P0。Mixed applied 成功出口、journal physical binding 与 post-E CAS 不再列为开放红灯。
`snapshot_restore_undo` journal-backed 属 A1c；LEGACY 移除属于后续迁移；Main/handler App 接线属于 A2，均不扩大本次 A1b 阻断清单。

## 4. 当前可复现证据

- `node tests/check-v0-0-4-test-registration.js --check`：221 scripts，52 current，40 Stage A，exit 0。
- `node tests/verify-v0-snapshot-restore-mixed-journey.js`：6/6，exit 0（含 formal rollback journey）。
- `node tests/verify-v0-snapshot-restore-service.js`：42/42，exit 0。
- `node tests/verify-v0-public-markdown-native-lifecycle.js`：67/67，exit 0。
- `WRC_A1B_E3_R=1 node tests/verify-v0-public-markdown-native-lifecycle.js`：78/78，exit 0。
- `WRC_A1B_E4_FA=1 node tests/verify-v0-public-markdown-native-lifecycle.js`：69/69，exit 0。
- `WRC_A1B_E2B_CONTROL=1 WRC_A1B_E2B_STAGE=1 WRC_A1B_E2B_APPLY=1 node tests/verify-v0-public-markdown-native-lifecycle.js`：89/89，exit 0。
- `node tests/verify-v0-public-markdown-native-rollback-create-lifecycle.js`：exit 0。
- `node tests/verify-v0-public-markdown-native-rollback-create-schema.js`：16/16，exit 0。
- `npm test`：exit 0。

Focused、schema、native 或 direct-service 绿灯是 component evidence；A1b 签收仍需一次完整独立复审。

## 5. 唯一下一动作

**对当前 clean local A1b tree（P0=0、P1=0）启动一次完整独立复审；复审通过后签收 A1b checkpoint。**

A1b 签收前，A1c、A2a–A2d、A3、A→B、Stage C/D/E、candidate、push/tag/release/publish/distribution 均冻结。

## 6. 门禁执行清单（无 CI 时的显式步骤）

- `npm run verify:syntax`
- `npm run verify:0.4:registration`
- `npm run verify:0.4:current-components`
- `npm test` / `npm run verify`

CI（`.github/workflows/verify.yml`）按 registration → syntax → current-components → test →
`npm audit --omit=dev` 编排；完整数字只在当前 checkpoint 出口重跑后更新。
