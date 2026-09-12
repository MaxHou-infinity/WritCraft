# WritCraft 2026-09-12 清理审计：三路只读审计结论与处置决议

> 性质：**维护批次审计记录，不是 checkpoint、不签收、不解锁任何冻结。**
> 授权：所有者 2026-09-12 授权（见 `docs/0.4.0-EXECUTION-PROTOCOL.md` 文末附）；基线与删除红线见
> [`CLEANUP-BASELINE-2026-09-12.md`](CLEANUP-BASELINE-2026-09-12.md)。
> 方法：三路**只读**审计并行执行（文档/仓库根、代码与依赖、测试可信度），父 agent 逐条独立复核；
> 审计期间的文档修订见本文件 §7。
> 基线：`b66975e`（审计启动时工作树干净）。

---

## 1. 结论摘要（先读这一段）

**这次审计最重要的发现不是"有很多文件可以删"，而是：这个仓库的主要冗余不是多余的*文件*，而是互相矛盾的*权威*。**

三条硬结论：

1. **几乎没有文档可以删。** 逐份核对后，全部 40 份 `docs/*.md` + 18 份 archive + `raw/` + `deliverables/`
   都承载着不可再生的追溯证据或仍然有效的兼容约束。**唯一安全的删除对象是 git 从未跟踪过的
   环境残留**（`.DS_Store`、一次过期的 Clang 静态分析输出、425 MB 打包产物）。
   删除文档不会瘦身，只会销毁失败证据。

2. **真正造成"重复踩坑"的是当前权威文档仍在描述签收前的状态。** 审计员 A 找到 5 处当前权威
   文档（状态账本、执行协议、0.4.0 路线图、验收合同、索引）在 A1b/A2a 已签收后**仍然告诉读者
   "还没签收、下一步是修 5 个 P1"**。任何按文档派工的 agent 都会重复已完成的工作或卡在已解除的
   冻结上。这已在本批次修正（§7）。

3. **测试的真实可信度低于其输出给人的印象，这是本批次真正的 P0。** 审计员 C 用可复现实验证明：
   - **81/223 个测试脚本不在 `npm test` / `verify` / `verify:full` 的任何一条链上**（42/223 连 CI 都跑不到），
     其中包含 0.4.0 Stage A/B 的 **50 个**组件证据；
   - **一个 A1b 门禁脚本（`verify-v0-changes-history-production-wiring.js`）在把 `main.js` 的关键调用
     包进 `if (false) {}` 之后仍然打印 "1/1 passed" 并 exit 0** —— 它证明的只是"源码里存在这些子串"
     （父 agent 已独立复核该脚本：93 行、26 条 `assert.match`/`doesNotMatch`、无任何文件写入或子进程，
     结论成立）；
   - **24 个脚本（3,098 行）的断言 100% 是源码文本 grep**，其中 14 个**零动态断言**，且全部位于
     `npm test` 或 CI 路径上；
   - **125 个文件**打印字面 `${passed}/${passed}`（同一标识符的宽口径为 136 个），即"N/N"在结构上无法表达失败；
   - 至少 4 处**静默跳过**把未执行的检查计入通过（含一个硬编码 `8/8`）。

   换句话说：**"绿灯"当前不能按字面理解。** 这是所有者说"不清楚测试方法、怕继续埋坑"的
   那个坑，而且它是真实存在的。

---

## 2. 审计范围与边界

| 审计 | 范围 | 方法 | 状态 |
|---|---|---|---|
| A | `docs/` 顶层 40 份、`docs/archive/` 18 份、仓库根、`raw/`、`deliverables/` | 链接完整性、过期声明、权威冲突、逐份删除判定 | 完成 |
| B | `v0/src/main` 可达性、依赖、重复实现、死代码 | 从三个真实入口重建 require 图 + 引用计数 | 完成 |
| C | `v0/tests` 223 个脚本的证据强度、门禁接线、可靠性 | 计算 npm script 闭包 + 实证破坏一个门禁脚本 | 完成 |

**未覆盖（明确声明）**：审计未运行完整 `npm test`/`verify:full`（C 只跑了失败的尾部脚本与注册/语法门禁）；
native C 源码正确性未审；A2a Electron 门禁只跑 1 次（n=1，未做负载复现）；审计开始时有 4 份文档
已被本批次修改（非审计员所为）。

**当前工程规模（本次实测，2026-09-12）**：`v0/src/main` 116 文件 / 75,859 行；renderer 20,875 行；
`v0/native/*.c` 8 文件 / 23,984 行；`v0/tests` 223 个 `verify-v0-*.js`（共 228 个 js）/ 94,513 行；
`docs/*.md` 40 份；`v0/release` 425 MB（未跟踪）。

---

## 3. 文档判定（审计 A + 父 agent 复核）

### 3.1 结论：全部保留；只做"过期声明"修正

审计 A 对每一份文档给出了"删除后会失去什么"。**没有任何一份文档的答案是"什么都不会失去"。**
因此本批次**不删除任何文档**，只修正与当前事实矛盾的声明。

特别保留（且不得再讨论删除）：

| 类别 | 代表文件 | 为什么不能删 |
|---|---|---|
| 签收证据 | `0.4.0-A1B-INDEPENDENT-REVIEW.md`、`0.4.0-A2A-INDEPENDENT-REVIEW.md` | 删除即让签核失效，必须重新复审（红线 a） |
| 当前权威 | `INDEX.md`、`DEVELOPMENT-STATUS.md`、`0.4.0-EXECUTION-PROTOCOL.md`、`ROADMAP*.md`、`EVIDENCE-DELIVERY-V1-CONTRACT.md` | 派工/事实/范围/验收的唯一入口 |
| 空载但必需 | `archive/engineering/A1B-BRANCH-DISPOSITION-2026-08-19.md` | **A1c 的前置基线 `649279c` 依赖此记录**（红线 c） |
| 冻结合同 | 13 份 `*-V1-CONTRACT.md` + 0.1.x–0.3.0 roadmap | 仍约束兼容回归；"过时"≠"无效"（红线 d） |
| 唯一副本 | `RAW/`、`deliverables/`、`archive/engineering/SIMPLIFICATION-PROPOSAL-2026-09-11.md` | 无任何重复副本 |
| 事故护栏 | `archive/engineering/INCIDENT-GUARDRAILS-THROUGH-2026-08-13.md` | `AGENTS.md` 按模块主动加载它 |

### 3.2 已修正的矛盾（详见 §7）

审计 A 编号 F1–F10，父 agent 逐条复核后确认并修复 F1–F7、F10；F8 一并修复。

| # | 严重度 | 问题 | 处置 |
|---|---|---|---|
| F1 | CRITICAL | A1b 的 GO 只写在矩阵与状态账本里，**复审文件本身仍写 NO-GO 且无确认段** | 已补写定点确认段 + 修正文件头（`ee92900`、`d6b9a79`） |
| F2 | CRITICAL | 5 处当前权威文档仍描述签收前状态（状态账本 §3/§4/§5、协议 §6、路线图 8/22/32/141 行、验收合同 :6） | 已全部改写 |
| F3 | HIGH | 公开版本已是 **0.3.1**，但 INDEX/README/GETTING-STARTED/PRD/npm 合同 6 处仍称 0.3.0 为当前 | 已全部修正，并记录 0.3.1 发布事实 |
| F4 | HIGH | 归档执行协议持**同一编号 `WRC-0.4.0-EXEC-R1`** 且仍自称"当前派工控制文件" | 已改为归档声明 |
| F5 | MEDIUM | 状态账本 §4 绿灯计数过期（222/53 → 实际 223/54） | 已修正 |
| F6 | MEDIUM | `archive/README.md` 漏列 6 份归档文件（含 load-bearing 的分支处置记录） | 已补全 |
| F7 | MEDIUM | `raw/README.md` 描述已不存在的 `raw/_back/` 目录 | 已修正 |
| F10 | MEDIUM | 两份**签收**复审记录都不在 `INDEX.md` 里 | 已新增专节 + 派工表行 |

### 3.3 两个被纠正的审计误判（父 agent 复核结论）

审计报告不是权威，复核发现两处误判，如实记录以维持审计本身的可信度：

1. **`deliverables/README.md:7` 并未失真。** 审计 A 称四份交付物"不含旧测试总数"；实测
   `deliverables/笔触 · WritCraft — 产品需求与价值说明.md` 含 `8/8`、`26/26`、`10/10` 等，
   `一个月 V0 路线图.md` 含 `34/34`、`121/121`、`13/13`。该行**保持原样**。

2. **E3/E2B 复审记录的 hash "漂移"不是缺陷，不得据此判定复审过期。**
   审计 B 发现 `0.4.0-A1B-E3-JOURNAL-SCHEMA-REVIEW.md` §4 的 9 个 payload hash 与当前工作树
   全部不一致，并建议"标记该记录为 superseded"。
   **复核结论：该建议错误，不予采纳。** 理由（均经父 agent 实测）：
   - 该记录是**带日期的、窗口内的快照绑定**，不是对当前树的持续声明。其 §6 明定 reviewer
     必须在"不修改 payload 的只读窗口内"完成冻结与重算，并规定"任一漂移立即作废**本轮**"——
     作废的是那个复核轮次，不是复审结论。
   - 记录自身 :69 明确："该 reviewer 回复就是终局签字；**不再回写本记录制造递归 hash 漂移**。"
     即**设计上就不把签字写进文件**。签字存在于 reviewer 的回复中（本仓库外部，Nowledge Mem
     记录：record SHA-256 `60cc032f…`、payload diff `sha256:f1b91ddb…` / 678096 bytes、
     2026-08-13、P0=0/P1=0/P2=0）。
   - 漂移有明确的正常原因：payload 第 3 项 `CHANGES-HISTORY-RECOVERY-V1-CONTRACT.md` 在
     2026-08-13 之后被 `259d7db`（文档治理提交）修改过（记录值 `c3920eaf…`，现值 `3e4a33dc…`）。
     签收之后继续开发必然改动 payload，这正是 §6 要求"只读窗口"的原因。
   - **因此不得编辑 E3/E2B/E3-binding 三份记录**：按 :69，回写它们才会制造真正的递归 hash 漂移。

   保留的**真实**残余：这三份记录的 §4 表格没有在表格内重复标注绑定日期，读者需回到文件头
   才能判断"漂移是预期的"。这是一个可选的**可读性**改进，不是证据缺陷；本批次不改（改了就漂移）。

3. **审计 C 的一处计数正确、一处计数错误、一处口径更窄**（父 agent 用可复现方法逐项重测）：

   | 审计 C 的说法 | 复核结论 | 实测（`verify-v0-*.js`，9e3e06e） |
   |---|---|---|
   | `spawnSync`/`execFileSync` **113 处** | **正确** | 113 处（同口径重测） |
   | 其中 **0 处带 `timeout`** | **错误** | **16 处带 `timeout`（9 个文件），97 处不带** |
   | 125/223 打印 `${passed}/${passed}` | **正确且更严谨** | 125 个文件匹配字面 `${passed}/${passed}`；`136/223` 是**更宽**的"同标识符 `${x}/${x}`"口径 |

   - 若把所有子进程形式（`spawnSync`/`execFileSync`/`execSync`/`spawn`/`execFile`）都算上，
     则是 **132 处调用、16 处带 `timeout`、116 处不带（26 个文件）**。
   - **"超时保护基本缺失"这一结论成立且严重**，但"一处都没有"不成立；本审计最初的
     "133 处、0 带超时"叙述同样不准确，此处一并更正。
   - 硬编码 `N/N` 字面量：实测 **14 个文件**（审计 C 报 15，扫描口径不同）。

---

## 4. 代码判定（审计 B + 父 agent 复核）

### 4.1 只有 2 个模块真正可删，共 855 行生产代码

| 模块 | 行数 | 证据 | 删除后失去什么 |
|---|---|---|---|
| `v0/src/main/changes-history-marker-journal.js` | 520 | `git log --all -S "require('./changes-history-marker-journal')"` **为空** —— 任何 ref 的任何提交都从未 require 它；唯一消费者是它自己的测试；native lifecycle 硬编码 helper 路径，无 JS 回退分支 | 12 个只测这个死实现的断言；以及 E3 记录 §4 第 6 行 payload（已因正常开发漂移） |
| `v0/src/main/project-onboarding-service.js` | 335 | 在仓库**第一次提交** `08b6338`（2026-07-26）时 `main.js` 就已经 require v2；v1 从未在任何 ref 进入生产路径；唯一引用者是自己测试 + 一个"main 不得 require v1"的负向断言 | 14 个只测 v1 的断言；v1 的 10 问分类法（git 可取回） |

**必须同一 change set 完成的收口**（红线 b，闭世界双射）：
删除 `tests/verify-v0-changes-history-marker-journal.js`（376 行）+ `tests/0.4.0-test-gates.json`
`expectedTestCount` 54→53；删除 `tests/verify-v0-project-onboarding.js`（257 行）+
`tests/0.4.0-legacy-test-baseline.json` 169→168 + `v0/package.json` 中 2 处引用。
**保留** `tests/verify-v0-project-onboarding-integration.js`（它是防止 v1 被重新接上的护栏）。

合计：**855 生产行 + 633 测试行 = 1,488 行**。

**审计 B 对先前提案的修正**（先前提案说"9 模块 / 7,041 行"）：
现在实际是 **7 模块 / 6,340 行** —— 因为 `snapshot-service.js`（384）与 `local-operation-service.js`（308）
已被**已签收的 A2a**（`b16ffc7`）接入 `main.js:22-23`。**这 692 行从"不可达"变成了"活的"。**
结论方向不变（可删 ≈ 855 行），但算术必须更正。

### 4.2 看着像死代码、实际是承重墙（不得动）

| 类别 | 行数 | 为什么不能动 |
|---|---|---|
| A2b/A2c/A2d 待接线服务（snapshot-compare 1588、delete 846、capability-store 591） | 4,102 | `codex/a1b-complete` 分支已写好；删除＝本项目已经付过一次代价的"重复实现"陷阱（红线 c） |
| `snapshot-restore-service.js` | 1,077 | **既是 A2c 待接线，又是 A1b 签收的行级证据**（`0.4.0-A1B-INDEPENDENT-REVIEW.md` 引用 `:864-895` 关闭 P1-4）。删除即让一条已生效的签核失效 |
| `author-acceptance-preflight-service.js` | 1,383 | 不是 app runtime，是发布工具链（`scripts/prepare-author-acceptance.js`、`scripts/verify-release.js`、装包校验） |
| 冻结 wire 内的死函数 | 87 | `public-markdown-native-schema.js` 的 2 个死函数位于**已签收的 A1b native wire 镜像**中，改动需重新复审 |
| 11 份 `*-schema.js`、reconciliation service、journal schema、两个活 C journal | ~14,000+ | 冻结的单权威恢复链；C journal 属 P0 威胁模型，需所有者显式授权 |
| `main.js` IPC 抽取 | — | 净 LOC 中性，且 A2b/A2c 还要动 `main.js` |

### 4.3 低价值、不建议本批处理

- **重复实现**：8 组字节相同的小函数共约 184 原始行 / ~100 净行（`isPlainObject` ×18 等）。
  总收益约 0.13%，且其中 `valuesOf`/`exactObject`/`publicMarkdownPath`/`digest`/`sha256`
  正是 CAS/revision/owner/project 的边界守卫，**合并它们是威胁模型变更，必须所有者授权**。
- **156 个"模块外无人引用"的导出**：属于导出面膨胀而非死代码（没有任何导出只存在于其定义处）。
- **~225 个"死"错误码**：renderer 会读 IPC 的 `error` 字段，删除会破坏 UI（审计 B 与先前结论一致）。
- **`v0/release/` 425 MB**：未跟踪、已 gitignore、内含打包好的 0.3.1 app + zip。删除可回收空间，
  但**不可由 git 恢复**（未跟踪），需所有者点头（见 §8）。

---

## 5. 测试判定（审计 C）——本批次真正的 P0

### 5.1 五个"绿"各不相同，且没有一个是超集

| 入口 | 覆盖的 `verify-v0` 脚本数 |
|---|---|
| `npm test` | 131 |
| `npm run verify` | 138 |
| `npm run verify:full` | 141 |
| `npm run verify:0.4:current-components`（41 Stage A + 9 Stage B） | 50 |
| CI（`.github/workflows/verify.yml`） | **181** |

- **81/223 不在 `test`/`verify`/`verify:full` 任何一条链上**；42/223 连 CI 都跑不到。
- 0.4.0 的 **50 个**组件证据（含 A1b/A2a native 证据）**只**通过 `--run` 选择器可达，
  而注册门禁明确**禁止**把它挂进 `pretest`/`preverify`；`verify:0.4:current-components`
  又不被任何其他脚本引用。
- **`npm test` 在本机当前是红的**（`verify-v0-npm-preview.js:51`，本机 npm 12.0.2 违反
  `engines.npm >=10 <12`）。**这是环境性红灯，不得为消红而放宽冻结门禁。**

### 5.2 证据强度实测分类（223 个脚本）

| 类 | 文件 | 断言数 | 一次绿证明什么 |
|---|---|---|---|
| A1 | 15 | 1,888 | 当次 `native/*.c` 现编 + 真实系统调用/fsync/fd 语义（含故障注入） |
| A2 | 2 | 94 | **已提交二进制**的行为（今日实测 8 个 helper 与现编逐字节相同，但**无任何机制保证**） |
| B | 12 | 918 | 真实 Electron 启动、真实 renderer/preload/IPC |
| C | 56 | 3,814 | 生产模块 + 真实文件系统 |
| D | 55 | 2,858 | 仅生产逻辑；所声明的边界被替换为注入/假实现 |
| E | 33 | 1,429 | 模块逻辑；无 DOM、无 Electron |
| F | 18 | 910 | 仅数据形状/hash/字段集；无 I/O |
| **G** | **24** | **1,153** | **仅"源码里存在这些子串"** |
| H | 3 | 234 | npm 打包 allowlist |
| X | 5 | 62 | 遗留 day1-5 冒烟 |

**14 个脚本（1,551 行）动态断言为零**，全部位于 `npm test` 或 CI 路径上：
workspace、project-intelligence、sources-ui、changes-review-ux、changes-review-integration、
graph-issue-handoff-integration、writing-navigation-main-wiring、assistant-integration、
writing-structure-main-wiring、delivery-preflight-ipc-boundary、image-trash-integration、
**changes-history-production-wiring**、ai-task-progress-renderer、context-autocomplete。

### 5.3 已实证的"假绿"（这是审计 C 最有价值的部分）

**实验**：把 `main.js` 中三个 create 调用包进 `if (false) {}`，并让被引用的 transaction 文件不定义任何东西。
`verify-v0-changes-history-production-wiring.js` 仍然打印 **"1/1 … passed" 并 exit 0**。
该脚本 `evidenceKind: 'production-wiring'`、`requiredInCurrentGate: true`，全文 93 行、
**26 条针对 `main.js`/`changes-history-transaction.js` 源码的正则**，不加载它声称验证的任何生产模块、
无文件写入、无子进程（父 agent 读全文核实；**该脚本不在任一签收复审的点名清单内**）。
同类的纯文本大文件还有 `verify-v0-project-intelligence.js`（94/94 断言是 `.includes`，横幅却自称
"项目智能**集成**检查"）与 `verify-v0-workspace.js`（104/108 是 `.includes`）。

**已捕获失败却仍打印"全过"（最危险的一条）**：
`verify-v0-research-apply-transaction.js:571` 在 `npm test`（pretest）与 `verify` 链上运行。
其 harness 捕获失败并置 `process.exitCode=1` 后**继续执行**，而 :571 的摘要行**没有**
`if (!process.exitCode)` 保护，且分母=分子。**实证：注入一个断言失败后，stdout 仍打印
`11/11 … passed`，而退出码为 1。** 这说明"人看日志"与"CI 看退出码"会得出相反结论。

**静默跳过计入通过**：
- `verify-v0-delivery-image-decode-service.js`：二进制/平台缺失时跳过 8 项中的 4 项，
  但 `test()` 仍 `passed += 1`，摘要硬编码 `${passed}/8` → **永远 8/8**。
- `verify-v0-author-affected-electron.js:190-192`、`author-cross-entry-electron.js:86-88`：
  即使 `WRITCRAFT_E2E_FORCE=1`，只要没设 `WRITCRAFT_E2E_AUTHOR_PROJECT` 就 **SKIP + exit 0**。
- `verify-v0-context-catalog-electron.js:41-44`：**完全无视 FORCE** 直接跳过。

**汇总行缺少退出码保护**：多数打印 `passed` 的汇总行没有 `if (!process.exitCode)` 保护
（父 agent 实测：按宽松口径有 206 行汇总行未提及 `exitCode`，仅 42 行提及；审计 C 报 99 行，
口径不同，但"大量未保护"成立）。这是 R1 要一并收口的第三个缺陷面。

**注意（审计 C 的反向结论，同样重要）**：套件里**不存在**"空洞断言"这一类问题 ——
0 个 `assert(true)`/自比较/空测试体，45 个"捕获后继续"的 harness **全部**置 `process.exitCode=1`，
退出码本身是诚实的。**问题不是断言写得假，而是测量对象选错了（测文本而非测行为）与报表机制坏了。**

**报告不可信**：**125 个文件**匹配字面 `${passed}/${passed}`（更宽的"同标识符 `${x}/${x}`"
口径为 **136 个**）；**14 个文件**打印硬编码 `N/N` 字面量；
`verify-v0-changes-history-marker-journal-native-lifecycle.js` 在同一文件里既打印 "1/1" 又打印 "10/10"。

### 5.4 门禁注册器真正保证了什么

**保证**：注册清册与目录的闭世界双射、54 条清单 7 字段完整、Stage A 必须 `completionEligible:false`、
Stage B/GUI 不得 `requiredInCurrentGate`、4 个门禁脚本的精确字符串锁、pretest/preverify 不得含组件套件。

**不保证**：
- **`requiredInCurrentGate` ≠ "在默认门禁里运行"**。它只影响 `--run stage-a-components` 的成员资格，
  而该命令不在 `test`/`verify`/`verify:full` 上。
- **`completionEligible` 不控制任何东西** —— 54 条全为 false，无代码据它授予或拒绝任何事，是装饰品。
- **`requiresGui: true` 是逃生门**：:142 让该条目完全豁免可达性规则，且从两个选择器中排除。
  **注册 ≠ 会运行**：两个 GUI 脚本都不在 CI 跑的任何门禁里。
- **`evidenceKind`/`lane`/`stage` 是自由文本**，注册器只做正则，不校验声明与脚本实际行为是否一致。
- 注册器**不读** `.github/workflows/verify.yml`，所以 CI 可以静默丢掉一个门禁。

### 5.5 可靠性

- **超时保护基本缺失**：`verify-v0-*.js` 中 113 处 `spawnSync`/`execFileSync` 里只有 **16 处**
  带 `timeout`（9 个文件），**97 处不带**；含全部子进程形式则为 132 处中 116 处不带（26 个文件）。
  门禁 runner（`check-v0-0-4-test-registration.js:187-191`）自身也没有超时；`npm test` 是一条
  `&&` 链。**一处 hang 仍可能挂住整条链。**
- `verify-v0-daily-workspace-data-runner.js:30` 的 `assert(Date.now() - started < 500)` 在 `npm test` 内，
  **按构造就是负载相关的**。
- A2a 那次 flake 是真实的，已在 `b16ffc7` 修复；审计 C 今日 n=1 未复现；该复审自身已声明 42/42 是弱证据。

### 5.6 测试脚手架重复

整文件重复**很低**（最大 pairwise Jaccard 0.532）。真正的重复是脚手架：
**186/223 文件各自实现计数 harness（54 种变体、1,063 行）**；失败模板重复 37 次；
89 个文件各自 `mkdtempSync`；**436 处**递归 `rmSync`；`v0/tests/` 下**根本没有共享 helper 模块**；
两套独立的假 DOM。**可在零断言损失下合并约 2,000–2,700 行（2.2–2.9%）。**

---

## 6. 关联：A1b 签收是否被审计 C 的发现推翻？

**没有。** 逐条核对：

- `verify-v0-changes-history-production-wiring.js`（93 行、26 条正则、末尾硬编码 `1/1` 的那个脚本）
  **不是** A1b 签收所依赖的证据。
  A1b 的 P1 闭合裁定是 reviewer 自己读码给出的 `file:line` 级证据
  （如 `public-markdown-create-helper.c:8267-8271`、`reconciliation-service.js:5398-5413`），
  不是任何 grep 测试的绿。
- 但这条发现确实意味着：**A1b 区域有一个注册门禁脚本是空壳**。修复它（见 §8 的 R1/R3）
  属于本批次授权的"测试可信度修复"，且**不属于**红线 a 的保护清单（该脚本未在任一签收复审中点名）。

---

## 7. 本批次已执行的修改（全部为文档，零行为变更）

| commit | 内容 |
|---|---|
| `b66975e` | Phase 0：审计基线、范围决策、四条删除红线 |
| `ee92900` + `d6b9a79` | **F1**：把 A1b 定点确认写入复审文件，并修正文件头使其不再与签收矛盾 |
| `7479983` | **F2–F7、F10**：清除状态账本/协议/路线图/验收合同中的签收前描述；0.3.1 全面校正；归档协议不再自称现行；补全 archive 索引；修正 `raw/_back` |

**已执行（截至本文件写入时）**：§8.1 的零风险删除（4 个 `.DS_Store` 与 `.omc/stage-a-quarantine-20260810/`）
已执行；§8.2 中所有者已点头的两项（`v0/release/`、1,488 行死代码）见 §11 执行记录。
**本批次未删除任何 git 已跟踪的文件**（除 §11 记录的 4 个死模块/死测试文件，它们由所有者逐项批准）。
删除需要所有者逐项点头（§8）。

---

## 8. 待所有者决策（逐项）

### 8.1 零风险批次（**已于 2026-09-12 执行**）

| 项 | 大小 | 为什么安全 | 状态 |
|---|---|---|---|
| `/`, `/v0/`, `/v0/src/`, `/raw/` 的 4 个 `.DS_Store` | ~10 KB | Finder 元数据，从未被 git 跟踪、被 `.gitignore:3` 忽略，Finder 会自动重建 | **已删除** |
| `.omc/stage-a-quarantine-20260810/`（2 个 `.plist`） | 156 KB | Stage A 之前一次 Clang 静态分析输出，零文档引用，可重跑得到 | **已删除** |

上述对象全部**从未进入 git**（逐个 `git log --` 验证为空），因此删除不产生 commit，也不可由 git 恢复；
选择删除的理由是它们零价值且可重建。删除后 `git status` 仍为干净。

### 8.2 需明确点头（有价值或有争议）

| 项 | 收益 | 风险 | 我的建议 |
|---|---|---|---|
| 删除 `v0/release/`（425 MB，打包好的 0.3.1 app + zip） | 回收 425 MB | **未被 git 跟踪，删了不可由 git 恢复**；但可由 0.3.1 源码重建 | 建议删；重建成本 > 保留价值，且它是唯一让"项目规模"测量失真的东西 |
| 删除 2 个死模块 + 2 个对应测试（1,488 行） | 真减少代码与测试 | 需同一 change set 收口注册清册；需先标记 `A1B-BRANCH-DISPOSITION` 无关（已确认无关） | 建议执行；这是本次唯一"真删除代码"的候选 |
| 追加 `RELEASE-NOTES-v0.3.1.md` | 补齐唯一缺失的版本发布说明 | 新增文件（与"清理"直觉相反） | 可选；已改为在 npm 合同记录发布事实。**若无异议我倾向不新增** |
| 为 0.3.1 补做 `verify:npm-preview:installed` | 补齐公开版本的装包验证证据 | 需联网、需真实耗时 | 建议排入 0.4.0 恢复后的独立批次，不混入清理 |

### 8.3 建议作为**下一批次**的测试可信度工程（本批次不做，避免一次改太多）

审计 C 给出的可执行反复发规则（R1–R7）。优先级：

1. **R1 报告诚实性** —— 禁止 `${passed}/${passed}` 与硬编码 `N/N`；要求
   `assert.strictEqual(passed, EXPECTED_TOTAL)` 后才打印。约 181 处一行级改动，**不改任何测试体**。
2. **R4 禁止静默跳过** —— 跳过必须计数并使文件非零退出（除非显式 `WRITCRAFT_ALLOW_SKIP=1`）。
   先处理 §5.3 的 4 个已知违规。
3. **R2 真实可达性** —— 删除 `requiresGui` 豁免；把"package.json 里出现过路径"换成执行闭包；
   并解析 `verify.yml` 断言 CI 未静默丢门禁。
4. **R5 超时** —— 门禁 runner 加 `timeout` + `killSignal`，失败标 `TIMEOUT` 而非读成 hang。
5. **R3 声明=实际** —— 把 `source-text` 提升为一等 `evidenceKind`，让 24 个纯静态脚本必须如实声明。
6. **R6 二进制新鲜度** —— 加一步"重建全部 helper 到临时目录并比对 sha256"（实测约 40 秒）。
7. **R7 分支治理工件化** —— PDCA Plan gate 必须落盘 `docs/plan/<task>.md`，含每个受影响符号的
   `git log --all -S` 命中表与分类；未分类命中即拒绝开工。
8. **脚手架合并** —— `v0/tests/` 增共享 helper，回收 2,000–2,700 行。**建议最后做**（触碰面最大）。

---

## 9. 明确不动的清单

- 两份签收复审、状态矩阵、执行协议、`INDEX.md`、`DEVELOPMENT-STATUS.md`、`ROADMAP*.md`、
  `EVIDENCE-DELIVERY-V1-CONTRACT.md` —— 已在 §7 修正，此后只读。
- `codex/a1b-complete` 分支及其处置记录 —— A1c 的前置基线（红线 c）。
- 全部 13 份 `*-V1-CONTRACT.md` 与 0.1.x–0.3.0 roadmap（红线 d）。
- 6 份 `0.4.0-A1B-E*-REVIEW.md`（唯一记录内部红证据；`INDEX.md` 已使其不可派工）。
- `snapshot-*` 待接线服务、reconciliation/journal 链、两个活 C journal、11 份 `*-schema.js`、
  `main.js` IPC 抽取、~225 个 IPC 可见错误码。
- `raw/`、`deliverables/` 内容（唯一副本）。
- **E3/E2B/E3-binding 三份复审记录** —— 按 §3.3，回写它们才会制造真实的 hash 漂移。
- `docs/` 的四层结构 —— 审计 A 判定其模型健全，**不做重组**。

---

## 10. 已知遗留（本批次未解决，如实记录）

1. 0.3.1 是否有对应的 GitHub tag/prerelease：本地无 `v0.3.1` tag，`git ls-remote --tags` 因网络超时
   未能确认。已按"**未验证**"记录在 npm 合同中。
2. 0.3.1 是否跑过 `verify:npm-preview:installed`：仓库无记录，已按缺口记录。
3. `snapshot-delete-service.js` 的 A2d 归属来自协议文本而非代码，未由代码证实。
4. 错误码统计（先前提案 1,061→709→484→225）与审计 B 的严格方法（1,058 个字面量、185 个仅出现一次）
   量级一致但方法不同，未统一。
5. `EVIDENCE-DELIVERY-V1-CONTRACT.md` 与 `CHANGES-HISTORY-RECOVERY-V1-CONTRACT.md` 的 Snapshot 权威
   是否重叠：审计 A 判断为互补（schema vs recovery），**未读全 165 KB 的后者**，仍待确认。
6. `docs/0.4.0-A1B-E*-REVIEW.md` 三份记录的 §4 表格未内联绑定日期（§3.3 的可读性残余）。

---

## 11. 执行记录：所有者已点头的删除，以及独立复审对本批次的更正

### 11.1 所有者批准后执行的删除（2026-09-12）

| 项 | 删除内容 | 可恢复性 |
|---|---|---|
| `v0/release/`（425 MB） | 打包好的 0.3.1 app + zip；未跟踪、已 gitignore | **不可由 git 恢复**；可由 0.3.1 源码重建 |
| 死代码对 1：`v0/src/main/changes-history-marker-journal.js`（520）+ `v0/tests/verify-v0-changes-history-marker-journal.js`（376） | 任何 ref 的任何提交都从未 require 过该模块 | git 历史保留 |
| 死代码对 2：`v0/src/main/project-onboarding-service.js`（335）+ `v0/tests/verify-v0-project-onboarding.js`（257） | 自仓库第一次提交起就从未进入生产路径 | git 历史保留 |
| 注册清册同步 | `0.4.0-test-gates.json` 54→53、`0.4.0-legacy-test-baseline.json` 169→168、`package.json` 移除 2 处引用 | 同一 change set（红线 b） |

合计删除 **1,488 行**（855 生产 + 633 测试）。同步后注册门禁实测：
`221 verify-v0 scripts classified (53 current, 168 legacy), 40 Stage A, 9 Stage B, 2 GUI-only`，exit 0。

**如实记录的代价**：审计 C 指出 marker-journal 的那 376 行测试含有 12 条 native 测试**未覆盖**的
断言（symlink 逃逸、注入式描述符链验证器、0755/0700 模式、nofollow 重开、陈旧 head 等）。
按 C 的判定"要么模块+测试一起删，要么都不删"，本批次选择了前者。**失去的是"一个死掉的 JS
journal 实现的唯一可执行规范"**；其格式权威仍在 `changes-history-marker-journal-schema.js`
（保留）与 `CHANGES-HISTORY-RECOVERY-V1-CONTRACT.md` §4.2.1，且该实现全文可从 git 取回。
**保留的守卫**：`tests/verify-v0-project-onboarding-integration.js` 未删，它断言 `main.js`
不得 require v1。

### 11.2 独立对抗性复审（`bcff6186`）对本批次提出的更正 —— 全部已采纳

复审对 `b66975e..7dc424e` 做只读对抗，提出 2 个 P1 + 4 个 P2。**6 条全部成立，已逐条修正**：

| # | 发现 | 处置 |
|---|---|---|
| **P1-1** | A1b 定点确认段绑定的 `1f43b7fc…` **不存在**（第 8 位应为 `3`），且它是 commit 却被写成 "tree" | 已改为完整 `1f43b7f3407f…` 并更正标签；两个复审文件中**全部** hash 现已逐个 `git cat-file` 验证有效 |
| **P1-2** | 该确认段**日期不可能**：写 2026-09-11，却绑定 `57daa08`（2026-09-12 19:48）并引用 `73c3bc6`（09-12 20:00）；且 P2-1 括注"8 删/8 增、100% 注释"与 `73c3bc6` 实际（2 文件 +12/−11，含非注释正文）不符 | 确认段与状态账本日期更正为 **2026-09-12**；括注改为实测值。**并发现同类错误波及 A2a**：A2a 复审 `Review date` 与定点确认同样写 09-11，实际绑定 09-12 的 `2b81494`/`b16ffc7`，已一并更正 |
| P2-3 | 本文 §7 说"没有删除任何文件"，§8.1 却说"已删除" —— 同一提交自相矛盾 | 已改写 §7 并新增本节 §11 |
| P2-4 | §5.5"113 处无一带 timeout"的绝对表述 | 见 §3.3 更正表：113 这个**计数是对的**，"0 带 timeout"错（16 处带） |
| P2-5 | 新增的 INDEX 规则说签收记录"删除或改写即失效"，而本批次自己改写了 A1b 复审文件 | 已把规则**限定**为"改写其结论/finding"；错别字与日期更正不属失效范围 |
| P2-6 | 状态账本 `最后更新` 仍为 09-11；§3 已改标题为"全部闭合"但条目 2 仍写"遗留待 reviewer 裁定" | 均已修正；V≡R 明确标注为**已裁定，不再是待办** |

**复审已验证为干净的部分**（摘要）：npm 0.3.1 全部事实与 registry 一致（含 shasum/integrity/time/fileCount
与 `74bc497`）；无 v0.3.1 GitHub tag；全部新相对链接可达；**当前派工控制文件有且只有一个**；
`src/main` 116/75,859 等规模数字复现；死模块结论复现；测试链数字（131/138/141/50/181）精确复现；
`safety`：`git diff --diff-filter=D/R b66975e..7dc424e` 为空，无红线被违反。

### 11.3 本批次之后仍需做的事

1. **R1+R4 测试可信度修复**（所有者已选为下一优先项）：R1 报告诚实性、R4 禁止静默跳过。
2. 随后考虑 R2/R3/R5/R6/R7（见 §8.3）。
3. 清理批次自身已通过独立对抗性复审（本节），可作为本批次的 close 证据。
