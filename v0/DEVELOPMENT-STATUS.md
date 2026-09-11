# 笔触 · WritCraft 当前开发状态

> 最后更新：2026-09-11
> 当前公开/代码版本：`writ-craft@0.3.1`（npm `preview`）
> 下一目标：`0.4.0` 证据与交付闭环（`WRC-0.4.0-R1`）
> 当前 checkpoint：**Stage A / A1b 独立复审 NO-GO（`e24bd51`，P0=0、P1=5、P2=1）；5 个 P1 的修复批次已实施**
> 当前结论：**5 个 P1 均已修复并有可复现证据；A1b 仍待同一独立 reviewer 定点确认 P0=0/P1=0 后才可签收；A1c、A2、Stage B 重签与 Stage C/D/E 继续冻结**
> 本批次实施记录：[`docs/archive/engineering/A1B-P1-FIX-PLAN-2026-09-11.md`](../docs/archive/engineering/A1B-P1-FIX-PLAN-2026-09-11.md)（预检分类、端口计划、缺陷与决策；不拥有派工权）

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

完整独立复审绑定 `e24bd51`，结论 P0=0、P1=5、P2=1。2026-09-11 修复批次的逐项状态：

1. **已闭合**：native E/R 现支持多 EXISTING 批量（`existing_execute_batch` / `existing_output_batch`
   / `existing_batch_publish_rollback`），证据 `WRC_A1B_E2B_*` 91/91。
2. **已闭合**：native `V` 已是真实只读复验并被 Main 消费（`E/R 后 fresh V`）；证据
   `WRC_A1B_E3_R=1` 78/78。**遗留待 reviewer 裁定**：V 与 R 在当前 native 实现中共用同一
   只读复验体，仅命令字不同；按 `0.4.0-A1B-EXISTING-STATE-MATRIX.md`「只有存储的
   publication 才能授权 fresh R/V」的冻结顺序，V 在 CAS 之后运行是有意设计，不另造第二套
   复验实现。
3. **已闭合**：Q/D/A 均已实现分阶段 WRCCHRJ2 publication 并具备重放/响应丢失恢复。
   本批次新增 `ROLLBACK_CREATE_PUBLICATION`（`QUARANTINED → ROLLED_BACK → ACK_COMMITTED`）
   与 `ROLLBACK_CREATE_ATTEMPT_PUBLICATION`（Q 之前的 `PREPARED` 写前 latch），
   ROLLED_BACK CAS 时 CREATE publication 的权威转移给 rollback publication。
   **边界测试还发现并修复了一个此前隐藏的真实 P1**：native D 在自身已提交后重放不幂等，
   导致「D 已提交、响应丢失或 `ROLLED_BACK` CAS 未持久化」窗口不可恢复。
   修复方式为 `rollback_delete_sealed`（已封存终态优先识别：重建 final record +
   逐字节 identity 精确 + 干净 rollback namespace；缺席本身从不作为充分条件）。
   6 个重启/响应丢失边界现全部收敛，native E 与 Q 不被重放。
4. **已闭合**：restore service 消费 `ROLLED_BACK` —— `runMixedJourney` 不再进入 History
   主线，`finish()` 落 `terminal/zero_write_error`，`clear()` 经
   `clearRollbackCreateJournal` 收敛到 IDLE；mixed journey 现已断言该完整出口与幂等重清。
5. **已闭合**：EXISTING ACK 走 `ACK_PREPARED` + per-item `I` 行精确移除，Main 前后双重校验；
   结构上无法满足该契约的遗留 item-less ACK 面已**退役**。

P2：`37e67e7` 含当前 main 缺失的 durable rollback publication 设计参考；本批次已按其设计
**定向适配**（未 cherry-pick、未整体合并）实现 journal 级
`ROLLBACK_CREATE_PUBLICATION` / `ROLLBACK_CREATE_ATTEMPT_PUBLICATION`。A1c/A2/Stage B–E 继续冻结。

## 4. 当前可复现证据

- `node tests/check-v0-0-4-test-registration.js --check`：222 scripts，53 current，41 Stage A，exit 0。
- `node tests/verify-v0-snapshot-restore-mixed-journey.js`：18/18，exit 0（含 formal rollback
  journey、`ROLLED_BACK`→IDLE 收敛与幂等重清、以及 6 个重启/响应丢失边界；其中 2 个是
  **`KNOWN DEFECT (P1)` 表征测试**，绿灯表示缺陷已被固定，**不表示 P1=0**）。
- `node tests/verify-v0-public-markdown-native-rollback-create-publication.js`：23/23，exit 0
  （新增；journal 级 ROLLBACK_CREATE publication 契约）。
- `node tests/verify-v0-snapshot-restore-service.js`：42/42，exit 0。
- `node tests/verify-v0-public-markdown-native-lifecycle.js`：67/67，exit 0。
- `WRC_A1B_E3_R=1 node tests/verify-v0-public-markdown-native-lifecycle.js`：78/78，exit 0。
- `WRC_A1B_E4_FA=1 node tests/verify-v0-public-markdown-native-lifecycle.js`：69/69，exit 0。
- `WRC_A1B_E2B_CONTROL=1 WRC_A1B_E2B_STAGE=1 WRC_A1B_E2B_APPLY=1 node tests/verify-v0-public-markdown-native-lifecycle.js`：89/89，exit 0。
- `node tests/verify-v0-public-markdown-native-rollback-create-lifecycle.js`：exit 0。
- `node tests/verify-v0-public-markdown-native-rollback-create-schema.js`：16/16，exit 0。
- `npm run verify:0.4:current-components`：41/41 Stage A + 9/9 Stage B preflight，exit 0。
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
