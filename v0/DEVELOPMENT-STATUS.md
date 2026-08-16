# 笔触 · WritCraft 当前开发状态

> 最后更新：2026-08-16
> 当前公开/代码版本：`writ-craft@0.3.1`（npm `preview`）
> 下一目标：`0.4.0` 证据与交付闭环（`WRC-0.4.0-R1`）
> 当前 checkpoint：**Stage A / A1b mixed EXISTING + `ROLLBACK_CREATE` 开发中**
> 当前结论：**P0=0；A1b 仍 NO-GO；A1c、A2、Stage B 重签与 Stage C/D/E 继续冻结**

## 1. 当前权威

- 产品范围：`docs/ROADMAP.md` 与 `docs/ROADMAP-0.4.0.md`。
- 执行顺序：`docs/0.4.0-EXECUTION-PROTOCOL.md`。
- A1b 状态/失败边界：`docs/0.4.0-A1B-EXISTING-STATE-MATRIX.md`。
- 当前工程事实：源码与可复现测试优先于文档快照。
- 2026-08-13 以前的完整轮次、测试数字与微 checkpoint 记录已逐字归档到
  [`docs/archive/development/DEVELOPMENT-STATUS-THROUGH-2026-08-13.md`](../docs/archive/development/DEVELOPMENT-STATUS-THROUGH-2026-08-13.md)。它是历史账本，不拥有派工权。

## 2. 已签收基线

- **A0**：0.4 测试清册、静态 orphan check 与 component 门禁已签收。
- **A1a**：CREATE finalize/ACK cleanup 的 Main/native/permanent-journal 纵切已签收。
- **A1b primary E**：one-leaf descriptor-bound EXISTING execute 已独立签收；不外推 R/V/F、rollback 或 mixed 总体。
- **E3 pure journal authority**：`existingTerminalPublication`、双 publication cleanup 与
  WRCCHRJ2 EXISTING journal-binding schema 已获得 P0=0、P1=0、P2=0 的独立证据。
- 上述都是已完成的窄边界，不代表 A1b、Stage A 或 0.4.0 candidate 完成。

## 3. 当前真实生产红灯

1. **Journal 物理绑定未接通**：现行 A1b 合同以 WRCCHRJ2 journal descriptor 为 E/R 权威；
   production lifecycle 仍要求 legacy `markerFd`，C helper 仍解析旧 E/R wire 并校验 legacy marker bytes。
2. **Main mixed publication CAS 未闭合**：post-E 的完整 terminal 尚未在 Main 中以单次
   WRCCHRJ2 CAS 持久为 `existingTerminalPublication`，响应丢失与 old/new head 协调尚未形成生产纵切。
3. **Mixed 事务出口未完成**：生产服务仍不能完成 mixed EXISTING + MISSING 的同事务
   E/R/V/F、History、`ROLLBACK_CREATE` 与 terminal cleanup 收口。

以上为当前全部 P1 生产缺口；没有已知 P0。纯 schema、fake adapter、direct service 或 focused 绿灯不能关闭它们。

## 4. A1b 单一出口

A1b 只在同一 production mixed 旅程同时证明以下事实后签收：

- EXISTING E 在 WRCCHRJ2 权威下完成，Main CAS 持久 terminal publication，不重放 E；
- fresh R/V 只使用 journal-stored identity，漂移、部分记录或不明响应保持 `UNKNOWN`；
- F/reconcileFinalize、History commit、ACK/cleanup 与 mixed terminal 完整收口；
- formal UNCOMMITTED 只能通过 `ROLLBACK_CREATE` 完整回到 operation-before；
- 生产 Main/native/filesystem 定向证据全绿，一次独立 A1b review 将 P0/P1 清零。

## 5. 唯一下一动作

**完成 A1b 生产纵切并一次性签收 A1b；不再创建 pure-schema/字段/线协议微 review。**

A1b 签收前，A1c Safe Undo、A2 App 接线、Stage A 总门禁、A→B 重签、Stage C/D/E、candidate、push/tag/release/publish/distribution 均冻结。

## 6. 门禁执行清单（无 CI 时的显式步骤）

0.4 主战场（marker/journal、snapshot、public-markdown native）的 39 个 Stage-A 组件测试
**不在** `npm test` / `npm run verify` 默认链内（注册门禁强制排除），无 CI 时必须显式执行：

- `npm run verify:syntax` — 全仓 `node --check`（394 个文件）
- `npm run verify:0.4:registration` — 测试清册 220/220 零漂移
- `npm run verify:0.4:current-components` — Stage A 组件 + Stage B Node preflight
- `npm test` / `npm run verify` — 默认 Node 行为套件（收尾共享 `verify:post-common`）

CI（`.github/workflows/verify.yml`）已按同一顺序编排：registration → syntax →
current-components → test → `npm audit --omit=dev`。
