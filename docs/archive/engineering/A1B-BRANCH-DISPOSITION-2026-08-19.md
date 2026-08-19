# A1b 并行分支处置记录（2026-08-19）

> 状态：一次性治理与追溯证据；不拥有派工权，不签收 A1b，也不解锁 A1c/A2。
> 当前派工仍以 `docs/0.4.0-EXECUTION-PROTOCOL.md` 与 `v0/DEVELOPMENT-STATUS.md` 为准。

## 1. 对账边界

- 当前 main：`e66c260ddc137dbb778cac1fd01f095fd56e9b82`。
- 对账分支：`codex/a1b-complete`，tip
  `b7fa28218876a3c9b8096b0e474dbb08166127bf`。
- merge base：`cb56c973198fb9d5780036e680aafd75b980aba6`。
- 分叉计数：`main..codex/a1b-complete = 13`；
  `codex/a1b-complete..main = 26`。
- 该分支原 worktree 元数据当前显示 `prunable`，但 branch ref 仍有效；本轮不执行
  prune、branch delete、merge、rebase、history rewrite 或 push。

## 2. 处置结论

| 分支提交/范围 | 当前分类 | 处置 |
|---|---|---|
| `37e67e7` A1b mixed recovery / D/A | main 生产实现已取代；测试意图可复用 | 不合并旧生产代码。将 main 缺失的 D 精确删除、A forged-phase、A exact-ACK replacement-preserve 三类 native 对抗测试适配到当前 schema |
| `649279c` A1c Safe Undo | 后续 checkpoint 候选 | A1b 签收前冻结；A1c 开启时先以该提交为既有实现基线，重新对照当前 authority、合同和测试后决定移植或拒绝 |
| `8880709` A2a create/list | 后续 checkpoint 候选 | A2a 开启前不得进入 main；届时按 production IPC/preload/Renderer 与 real Electron 要求重新评估 |
| `8fada06` 至 `e3411f1` compare/UI | A2b 候选 | 不以旧分支的“close A2b”文档签收当前 checkpoint；当前协议下重新独立验收 |
| `b7fa282` selected restore | A2c 候选，不是当前协议的 A2b | 禁止整体合并；A2c 开启时再对照 History reconcile、Safe Undo 和真实 App 边界 |

## 3. A1b 对账结果

main 已包含 D/A 生产实现和真实 mixed `Q → fresh R → D → A → ROLLED_BACK`
集成旅程，但原先缺少 `37e67e7` 中三类直接 native 对抗断言。本轮只移植测试意图：

1. D 仅删除 token 绑定的精确 quarantine identity，写出 `FINALIZED`；同内容新 inode
   replacement 返回 `UNKNOWN` 并保留双方；
2. A 独立拒绝 forged `ROLLED_BACK` phase digest，保留 final/control/receipt；
3. A 精确 ACK 后清理 final/control/receipt；final 同内容新 inode replacement 返回
   `UNKNOWN` 并保留双方。

适配后的测试直接进入现有
`tests/verify-v0-public-markdown-native-rollback-create-lifecycle.js` 默认执行路径，
不新增脚本，因此既有 0.4 测试清册条目继续覆盖它。focused 结果为 exit 0；未发现需要移植的旧生产实现。

## 4. 后续边界

- A1b 仍须绑定 clean exact tree 完成一次独立 review；上述测试绿灯只是补强 checkpoint evidence。
- 在 A1b 独立签收前，A1c、A2a–A2d、A3、A→B、Stage C/D/E 继续冻结。
- `codex/a1b-complete` 保留到其中各提交完成当前 checkpoint 重新分类；任何删除或归档动作由所有者另行授权。
