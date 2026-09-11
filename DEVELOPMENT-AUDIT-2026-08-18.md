# WritCraft 项目开发行为审计报告

> 审计日期：2026-08-18
> 审计对象：WritCraft 仓库（`/Users/maxhou/Desktop/Max 项目-2026/监控中枢/editor`）
> 审计范围：①当前 A1b checkpoint 是否存在循环开发 / 反复修补；②过往 git 历史中的同类行为
> 审计方法：git 历史统计、分支分叉分析、提交主题聚类、与并行分支功能对账

---

## 摘要（TL;DR）

- **当前 A1b 的调试不是循环**：mixed journey 从红灯到 6/6 的每一轮都定位到新的独立根因，属于正常故障隔离推进。
- **但整个 A1b 存在一次显著的重复实现**：并行分支 `codex/a1b-complete` 在 **08-13** 就已完整实现 `ROLLBACK_CREATE` 的 D/A（delete/ack），而 main 分支直到 **08-18** 才重新实现了一遍几乎相同的功能——重复消耗了实现与调试 token。
- **过往开发存在高密度微修补与文档反复改写**：7 月底至 8 月初的 `navigation` / `plan` 系列在 3 天内对同一文件提交 11 次；`DEVELOPMENT-STATUS.md` 累计被改 154 次、`AUTHOR-ACCEPTANCE-V1-CONTRACT.md` 88 次。
- **根因是分支治理缺失 + 实现纪律不均**，最值得立即修复的是 `codex/a1b-complete` 分支的处置缺失。

---

## 一、当前 A1b 阶段

### 1.1 确凿的重复劳动：main 分支重新实现了并行分支已有的 D/A 功能

这是本轮最重要的发现。

| 事实 | 证据 |
|---|---|
| 并行分支 `codex/a1b-complete` 在 08-13 已完整实现 D/A | 提交 `37e67e7`（08-13 16:19）首次出现 `rollback_settle` / `rollback_ack` / `rollback_build_final` / `rollback_delete_quarantine_one`，并带完整测试：`PASS D exact-deletes quarantine, publishes FINALIZED and preserves replacement`、`PASS A independently rejects a forged ROLLED_BACK phase digest`、`PASS A exact-ACKs stored ROLLED_BACK records and preserves replacement` |
| main 直到 08-18 才实现相同功能 | 提交 `e66c260` 才加入 `rollback_delete` / `rollback_ack` / `rollback_build_final_record`，与 codex 分支语义几乎逐行对应（settle=FINALIZED+identity、ack 校验 ROLLED_BACK phase、dual digest scheme） |
| 该分支从未合并 | `git rev-list --count main..codex/a1b-complete` = 13；`codex/a1b-complete..main` = 26；分叉点在 `cb56c97`（08-06） |
| 分支上还有未合并的 A1c/A2b 成果 | `649279c feat(recovery): complete A1c safe undo`、`b7fa282 feat(snapshot): restore selected markdown safely`（+1298 行） |
| 文档无任何 codex 分支废弃/处置记录 | grep `docs/`、`v0/DEVELOPMENT-STATUS.md`、`AGENTS.md` 均零命中 |

**结论**：`codex/a1b-complete` 分支上的 D/A 工作（08-13）从未被合并或正式废弃，main 在 5 天后（08-18）重新实现了一遍。这不仅重复消耗了实现 token，还重复消耗了调试 token——两个实现各自踩了相同类型的坑（digest scheme、restored-leaf revision、namespace clean）。

### 1.2 本轮的逐层小步修补（mixed journey 调试路径）

从本会话实际过程看，mixed journey 从红灯到 6/6 经历了 8+ 轮独立错误定位：

1. lifecycle scoped 未暴露 rollback 方法
2. restored-leaf digest revision 错配（after_revision vs before_revision）
3. missing-public 的 created-digest scheme（journal OBJECT vs legacy CREATED_SCHEMA）
4. Q 的 `rollback_quarantine_one` 存在同样的 scheme 错配
5. D 命令未实现（返回 UNKNOWN）
6. D 实现后 final-record identity 校验
7. service 状态检查错误（`COMMITTED` vs schema 的 `FINALIZED`）
8. 测试断言错误（`rollbackReceiptDigest` 应为 digest 而非 null）

**评估**：这是**正常的故障隔离推进**（每轮都是新根因、有 C 侧 debug 探针定位），不是原地打转。但它暴露了流程问题：**这些错误大多源于"在冻结 schema 与既有 native 边界之上重新推导语义"，而非参考已有实现**。如果当时先查看 `codex/a1b-complete` 分支或先对照 schema 测试的期望，多数轮次可以合并。

---

## 二、过往开发行为

### 2.1 提交总量与类型分布

- 提交总数：**179**（main）
- 类型分布：

| 类型 | 数量 | 占比 |
|---|---|---|
| docs | 88 | 49% |
| fix | 51 | 29% |
| feat | 19 | 11% |
| test | 8 | 4% |
| release | 4 | 2% |
| chore / refactor / 其他 | 9 | 5% |

- **一半提交是文档提交**，且 `fix` 主题高度集中：`navigation` 10 次、`watcher` 6 次、`plan` 6 次、`onboarding` 4 次、`history` 3 次。

### 2.2 同一文件被反复修补

按文件改动次数 TOP：

| 文件 | 改动次数 |
|---|---|
| `v0/DEVELOPMENT-STATUS.md` | **154** |
| `docs/AUTHOR-ACCEPTANCE-V1-CONTRACT.md` | 88 |
| `docs/ROADMAP.md` | 72 |
| `docs/PHASE-A-IMPLEMENTATION.md` | 53 |
| `README.md` | 50 |
| `docs/WRITCRAFT-PRD-V3.md` | 47 |
| `AGENTS.md` | 44 |
| `v0/tests/verify-v0-electron-e2e.js` | 33 |
| `v0/package.json` | 33 |
| `v0/src/main/main.js` | 26 |

其中 `DEVELOPMENT-STATUS.md` 按日期分布：

```
07-26:  4次    07-30: 38次    08-03: 11次
07-27:  9次    07-31: 24次    08-04:  5次
07-28: 12次    08-01: 18次    08-05:  2次
07-29: 20次    08-02:  5次    08-06:  1次
                             08-16:  3次
                             08-17:  1次
                             08-18:  1次
```

### 2.3 高密度期（07-31 ~ 08-02）：navigation/plan 连续修补序列

```
07-31 08:47 fix(plan): retry peripheral JSON once
07-31 09:12 fix(plan): retry invalid array structure once
07-31 09:52 fix(plan): require structured tool output
07-31 10:55 fix(plan): bound structured output envelope
07-31 11:33 fix(plan): require exact dependency ids
07-31 15:36 fix(navigation): preserve author input focus
07-31 17:15 fix(navigation): bind model evidence by reference
08-01 12:52 fix(navigation): bound changes handoff output
08-01 13:59 fix(navigation): bound localized changes by ranges
08-01 16:55 fix(navigation): restore progress and expose actions
08-01 18:50 fix(navigation): keep research actions retryable
08-01 22:26 fix(navigation): localize unified task edits
08-01 22:52 fix(navigation): bind unified edit authority
08-02 10:53 fix(navigation): require manuscript context
08-02 14:33 fix(navigation): bind one local edit anchor
```

同一个 `writing-navigation-state.js` 在 07-31 ~ 08-02 三天内被 **11 个提交**触碰；`writing-navigation-handoff-service.js` 被 9 个提交触碰。这是典型的**功能未在首次实现时闭合边界 → 逐个发现漏洞逐个打补丁**模式，说明早期实现缺乏"一次写完整状态机 + 对抗测试"的纪律。

### 2.4 文档与代码交替提交的高频循环（07-30 峰值日）

07-30 单日 38 次改 `DEVELOPMENT-STATUS.md`，提交序列呈现 `docs(status) → fix(xxx) → docs(acceptance) → docs(status)` 的密集交替。表示**一个功能点拆成"记录-修复-再记录"多笔提交**，而非一笔自洽提交——Token 消耗分散，复查成本高。

---

## 三、量化浪费估算

> 以下为基于提交统计与代码行数的保守估算，非精确计量。

| 项 | 估算 |
|---|---|
| codex 分支 D/A 重复实现（main 侧） | `e66c260` 的 809 行中，D/A 核心约 **300–400 行与 codex 分支重复**；加上 5 天前 codex 分支已写过的约 250 行 |
| codex 分支整体未合并 | A1c safe undo + A2b restore + compare ≈ **+1300 行**从未进入 main，若最终并入还需合并冲突成本 |
| 高密度微修补（navigation 3 天 11 笔） | 每笔提交含重新验证 + 文档同步，保守估计等效 **2–3 倍完整实现的 token** |
| 文档反复改写 | `DEVELOPMENT-STATUS.md` 154 次 + `AUTHOR-ACCEPTANCE-V1-CONTRACT.md` 88 次，大部分是状态快照而非契约变更 |

---

## 四、根因判断

1. **分支治理缺失**（最主要）：`codex/a1b-complete` 与 main 并行开发同一 checkpoint，却没有任何合并/废弃决策记录；分支分叉后 10 天（08-06 ~ 08-16）无任何处置。AGENTS.md 要求"独立复审绑定 clean commit"，但该分支既未被并入也未归档。
2. **实现纪律不均**：早期（7 月底）倾向"先出可用再逐步补洞"（微修补）；近期 A1b（08-16 ~ 08-18）已明显改善为"focused 门禁先行"，但本轮 D/A 因未先查既有分支而重复。
3. **文档提交稀释**：一半提交是 docs，且频繁改写同一状态文档，容易掩盖"真正推进了多少实现"。

---

## 五、建议（按优先级）

1. **立即处置 codex 分支**（最高优先）：由所有者决策 `codex/a1b-complete` 是合并、废弃还是归档。若其 A1c/A2b 成果有效，应作为后续 A1c/A2 的起点而非重写——**这能避免下一次重复劳动**。
2. **本轮 D/A 与 codex 分支做差异对账**：确认 main 的实现是否覆盖 codex 的 D/A 语义（FINALIZED / ACKED / forged-phase / identity-preserve 测试）；若 codex 的测试更全，可移植其测试用例到 main 省去重写。
3. **建立"开工前查分支"清单**：在 AGENTS.md 或执行协议中加入"涉及 A1b/A1c 已有并行分支时，先 `git log --all` 对账既有实现"。
4. **收敛微提交**：同一功能应在一次自洽提交内闭合（源码 + 测试 + 状态更新一次完成），减少 docs/status 高频交替。
5. **长期**：将 `DEVELOPMENT-STATUS.md` 的高频改写改为"checkpoint 开口/关闭时更新"，日常轮次结果只追加到归档。

---

## 附：审计用命令（可复现）

```bash
# 提交总量与类型
git rev-list --count HEAD
git log --oneline main | awk '{print $2}' | sed 's/(.*//' | sort | uniq -c | sort -rn

# 分支分叉分析
git merge-base main codex/a1b-complete
git rev-list --count main..codex/a1b-complete
git rev-list --count codex/a1b-complete..main

# 文件改动频次
git log --pretty=format: --name-only | grep -v '^$' | sort | uniq -c | sort -rn | head -25

# 按主题聚类 fix
git log --oneline main | grep ' fix' | sed -E 's/^[0-9a-f]+ fix\(([^)]*)\).*/\1/' | sort | uniq -c | sort -rn

# 核心文件提交序列
git log --oneline main --pretty=format:'%h %ad %s' --date=format:'%m-%d %H:%M' -- <file>

# codex 分支 D/A 是否存在
git show codex/a1b-complete:v0/native/public-markdown-create-helper.c | grep -cE 'rollback_settle|rollback_ack\b|rollback_delete'
```

---

*报告基于 2026-08-18 的 git 历史快照生成；提交哈希与计数以当时 `HEAD`（`e66c260`）为准。*
