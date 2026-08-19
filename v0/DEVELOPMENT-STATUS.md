# 笔触 · WritCraft 当前开发状态

> 最后更新：2026-08-19
> 当前公开/代码版本：`writ-craft@0.3.1`（npm `preview`）
> 下一目标：`0.4.0` 证据与交付闭环（`WRC-0.4.0-R1`）
> 当前 checkpoint：**Stage A / A1b 独立复审 NO-GO，修复 mixed EXISTING + `ROLLBACK_CREATE` 的 5 个 P1**
> 当前结论：**P0=0、P1=5、P2=1；A1b 未签收；A1c、A2、Stage B 重签与 Stage C/D/E 继续冻结**

## 1. 当前权威

- 产品范围：`docs/ROADMAP.md` 与 `docs/ROADMAP-0.4.0.md`。
- 执行顺序：`docs/0.4.0-EXECUTION-PROTOCOL.md`。
- A1b 状态/失败边界：`docs/0.4.0-A1B-EXISTING-STATE-MATRIX.md`。
- 当前工程事实：源码与可复现测试优先于文档快照。
- A1b 本轮提交与 component 证据汇总见
  [`docs/archive/engineering/A1B-INDEPENDENT-REVIEW-MATERIALS-2026-08-16.md`](../docs/archive/engineering/A1B-INDEPENDENT-REVIEW-MATERIALS-2026-08-16.md)；它不是签收记录，也不拥有派工权。
- 当前完整 finding batch 见
  [`docs/0.4.0-A1B-INDEPENDENT-REVIEW.md`](../docs/0.4.0-A1B-INDEPENDENT-REVIEW.md)。

## 2. 已完成边界

- **A0** 与 **A1a** 已签收；A1b primary E 与 E3 pure journal authority 保留其既有窄层独立证据。
- `dcc197c` 前后的 A1b 实现已完成 WRCCHRJ2 journal 单权威 E/R wire、native
  `ROLLBACK_CREATE` Q/R/D/A、Main post-E terminal CAS，以及 mixed applied 主线：
  `PRECREATE → CREATED_RECEIPT → EXISTING_COMMITTED → HISTORY_COMMITTED → FINALIZED → ACK_COMMITTED → IDLE`。
- fresh R stored-publication identity 与单项 `Q → fresh R → D → A → ROLLED_BACK`
  是已通过的 component/integration evidence，但独立复审证明它们没有闭合完整 checkpoint。
- `e24bd51` 补入 D 精确删除、A forged-phase、A exact-ACK replacement-preserve
  三类 native 对抗测试；测试全绿，未改变下面的 5 个生产 P1。

## 3. 当前 P1

完整独立复审绑定 `e24bd51`，结论 P0=0、P1=5、P2=1：

1. Native E/R 只实现单个 EXISTING；合法的多 EXISTING mixed selection 固定为 `UNKNOWN`。
2. Native `V verify` 仍为空操作，Main 也未在接受 E/R terminal 前强制 fresh V。
3. `ROLLBACK_CREATE` Q/D/A 缺少分阶段 WRCCHRJ2 publication；A 在 `ROLLED_BACK`
   CAS 前删除恢复记录，崩溃窗口不可恢复。
4. Snapshot restore service 不消费 `ROLLED_BACK`，已证明的零净写回滚被外推为
   `UNKNOWN`/manual。
5. EXISTING ACK 没有 exact-remove control/apply/final records，却发布
   `ACK_COMMITTED` 并清到 IDLE。

P2：`37e67e7` 含当前 main 缺失的 durable rollback publication 设计参考，不能标为已被
main 完全取代，也不能在 P1 修复前删除分支。A1c/A2/Stage B–E 继续冻结。

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
- `npm run verify:0.4:current-components`：40/40 Stage A + 9/9 Stage B preflight，exit 0。
- `npm test`：受限沙箱首红为 Electron `code=null`；真实 Electron 权限重跑 exit 0。

以上绿灯没有覆盖或推翻独立复审的 5 个合同/生产边界 P1。

## 5. 唯一下一动作

**按 authority 依赖顺序修复 5 个 P1，运行 focused production gates，并由同一独立 reviewer 对原 finding batch 定点确认。**

A1b 签收前，A1c、A2a–A2d、A3、A→B、Stage C/D/E、candidate、push/tag/release/publish/distribution 均冻结。

## 6. 门禁执行清单（无 CI 时的显式步骤）

- `npm run verify:syntax`
- `npm run verify:0.4:registration`
- `npm run verify:0.4:current-components`
- `npm test` / `npm run verify`

CI（`.github/workflows/verify.yml`）按 registration → syntax → current-components → test →
`npm audit --omit=dev` 编排；完整数字只在当前 checkpoint 出口重跑后更新。
