# 笔触 WritCraft · 测试方法与"绿灯"含义（所有者向）

> 最后更新：2026-09-12（清理审计批次）。数据在 `7dc424e` 实测。
> 本文回答一个问题：**我运行了一条命令、它变绿了——它到底证明了什么？**
> 本文不新增门禁、不改变任何测试。它只如实描述当前状态，包括当前**不好**的部分。

---

## 1. 三十秒版本

1. **有五个不同的"绿"，没有一个包含其他所有绿。** 记住 `verify:0.4:current-components` 是唯一
   跑 0.4.0 checkpoint 证据的命令，而它**不在** `npm test` 链上。
2. **`npm test` 在本机当前是红的**，原因与本项目代码无关（本机 npm 版本越界）。**不要为消红而改门禁。**
3. **不要读脚本打印的 `N/N`。** 223 个脚本里有 125 个打印 `passed/passed`，这个数字在结构上
   无法表达失败。**只读退出码。** 看到 `SKIP` 就当"没跑"。
4. **"组件绿"不等于"功能可用"，更不等于签收。** 详见 §5。

---

## 2. 五个入口，各证明什么

在 `v0/` 目录下运行。

| 命令 | 它跑的脚本数 | 它证明什么 | 它**不**证明什么 |
|---|---|---|---|
| `npm test` | 131 | 0.1.x–0.3.x 的遗留回归基线 + 部分架构/边界检查 | 不跑 0.4.0 组件门禁；不跑多数 Electron E2E；不跑 81 个脚本中的任何一个 |
| `npm run verify` | 138 | 上一行 + 打包/API key/PDF/用户数据等 | 同上；仍不含 Electron |
| `npm run verify:full` | 141 | 上一行 + **真实 Electron E2E**（强制 `WRITCRAFT_E2E_FORCE=1`） | 仍不含 0.4.0 组件门禁；作者类 E2E 需要额外项目变量才会真的跑（见 §6） |
| `npm run verify:0.4:current-components` | **50** | **0.4.0 Stage A 的 41 个 + Stage B 的 9 个组件证据（含 A1b/A2a native 证据）** | 不是 App/Stage/candidate/release 签收 |
| CI（`.github/workflows/verify.yml`） | 181 | 上述大部分 + 注册/语法 | 42 个脚本连 CI 都跑不到 |

**关键事实**：`npm test`、`verify`、`verify:full` **三条链上都没有 0.4.0 的 checkpoint 证据**。
注册门禁（`check-v0-0-4-test-registration.js:130-133`）**明确禁止**把 `stage-a-components` 挂进
`pretest`/`preverify`；它只能通过 `verify:0.4:current-components` 或直接 `--run` 触达，
而 `verify:0.4:current-components` 不被任何其他脚本引用。

**所以：想在本地复现 0.4.0 的证据，必须显式运行这一条。**

```bash
cd v0
npm run verify:0.4:current-components     # 41 Stage A + 9 Stage B
npm run verify:0.4:registration          # 只看注册清册是否自洽
```

---

## 3. 本机当前的红色（环境性，**不要修**）

```
$ cd v0 && npm test
...
verify-v0-npm-preview.js:51  →  FAIL
```

原因：`v0/package.json` 的 `engines.npm` 是 `">=10 <12"`，而本机是 **npm 12.0.2**。
`verify-v0-npm-preview.js:51` 依赖 `npm pack --dry-run --json` 返回**数组**；npm ≥12 返回
**以包名为键的对象**，于是 `Array.isArray(report)` 为假。

- 这**不是**本项目代码缺陷，也**不是**该测试写错——npm 12 明确在合同的 `engines` 范围之外。
- **不要**为了让本机变绿而放宽 `verify-v0-npm-preview.js` 或 `engines`。它是**冻结门禁**，
  放宽等于伪造发布前证据。
- 处理办法：用 npm 10 或 11 跑；或接受 `npm test` 在 npm 12 上必然红，改用
  `verify:0.4:current-components` + 各专项命令。

---

## 4. 如何读输出

| 你看到的 | 含义 |
|---|---|
| 退出码 0 | 该脚本没抛断言错误。**这是唯一可信的信号。** |
| `103/103 passed` | **先别信。** **125 个**脚本打印字面 `${passed}/${passed}`——分母就是分子，永远相等；按更宽的"同标识符 `${x}/${x}`"口径是 **136 个**；另有 **14 个**打印硬编码的 `N/N` 字面量（实测口径见审计 §3.3） |
| `SKIP ...` | **本次什么都没证明。** 至少 4 处跳过路径会计入通过甚至硬编码分母（§6） |
| 没有输出但退出码 0 | 可能正常，也可能是纯文本 grep 脚本（§6） |
| 进程挂住不返回 | 超时保护只覆盖一部分（§7）。可能只能手动 kill |

**判断一个测试是真跑还是空跑，最快的办法是看它有没有碰真实文件/真实进程**：打开脚本，
搜索 `mkdtemp`、`spawnSync`、`execFileSync`、`new Worker`、`clang`。一个都没有的，
它多半只是在 grep 源码文本。

---

## 5. 证据阶梯：什么算数

从强到弱（2026-09-12 审计实测分类，223 个脚本）：

| 类 | 个数 | 一次绿真正证明了 |
|---|---|---|
| **A1** 当次用 `native/*.c` 现编并真实 `spawn` | 15 | 真实 C 代码 + 真实系统调用/fsync/fd 语义（含故障注入）——**最强的证据** |
| **A2** 用**已提交的** native 二进制 | 2 | 仅仅是"已提交字节的行为"；今日实测二进制与现编一致，但**没有机制保证**（§6） |
| **B** 真实 Electron 启动（CDP） | 12 | App 真的起来了、真实 renderer/preload/IPC |
| **C** 生产模块 + 真实文件系统 | 56 | 生产代码驱动真实文件，断言真实字节 |
| **D** 生产模块 in-process，边界被替换 | 55 | 只有生产**逻辑**；它声称的那个边界被替换掉了 |
| **E** renderer/shared 模块在 Node 里跑 | 33 | 模块逻辑；无 DOM、无 Electron、无浏览器 |
| **F** 纯 schema/合同（shape/hash/字段集） | 18 | 数据结构形状；**无任何 I/O** |
| **G** **纯源码文本 grep** | **24** | **只是"这些子串存在于源码里"** |
| **H** 打包/工具链 | 3 | npm tarball allowlist |

**14 个脚本（1,551 行）动态断言为零，全部在 `npm test` 或 CI 路径上。**
名字听起来很有力但实际是 G 类的例子：`verify-v0-changes-history-production-wiring.js`
（93 行、100% 是 `main.js` 与 `changes-history-transaction.js` 上的 26 条正则，末尾硬编码打印 `1/1`）、
`verify-v0-delivery-preflight-ipc-boundary.js`、`verify-v0-network-boundary.js`（91 条断言里 79 条是文本）、
`verify-v0-workspace.js`（204 条断言全是 HTML/JS 子串）。

**已实证的假绿**：把 `main.js` 里三个 create 调用包进 `if (false) {}`、并让被引用的 transaction
文件不定义任何东西之后，`verify-v0-changes-history-production-wiring.js` **仍然打印 "1/1 passed"
并 exit 0**。它证明的只是子串存在。

> **这一节是本项目当前最大的工程风险**，也是所有者"怕继续埋坑"的那个坑。修复计划见
> [`archive/engineering/CLEANUP-AUDIT-2026-09-12.md`](archive/engineering/CLEANUP-AUDIT-2026-09-12.md) §8.3。

---

## 6. 已知陷阱（都会让"绿"失真）

1. **静默跳过计入通过**
   - `verify-v0-delivery-image-decode-service.js`：二进制/平台缺失时跳过 8 项中的 4 项，
     但 `test()` 仍 `passed += 1`，摘要硬编码 `${passed}/8` → **永远 8/8**。
   - `verify-v0-author-affected-electron.js`、`verify-v0-author-cross-entry-electron.js`：
     **即使 `WRITCRAFT_E2E_FORCE=1`**，只要没设 `WRITCRAFT_E2E_AUTHOR_PROJECT` 就 SKIP 并 exit 0。
   - `verify-v0-context-catalog-electron.js`：**完全无视 FORCE** 直接跳过。
2. **`requiresGui: true` 是注册器的逃生门**：`check-v0-0-4-test-registration.js:142` 让该条目
   完全豁免可达性规则。**注册 ≠ 会运行**——两个 GUI 脚本都不在 CI 跑的任何门禁里。
3. **`completionEligible` 不控制任何东西**：54 条全为 `false`，没有代码据它授予或拒绝任何事。
4. **`evidenceKind` / `lane` 是自由文本**：注册器不校验声明与实际行为是否一致，
   所以一个 grep 脚本可以自称 `production-wiring`。
5. **已提交的 native 二进制没有新鲜度门禁**：2026-09-12 实测 8 个 helper 与现编逐字节相同，
   但 CI 是**重建并覆盖**而不是**验证**，`npm test` 从不重建。**改了 `.c` 之后，
   旧字节仍可能继续"证明"新代码。**
6. **注册器不读 `verify.yml`**：CI 可以静默丢掉一个门禁而没有任何本地红灯。
7. **同名不同强度**：`-integration`、`-service`、`-renderer`、`-api`、`-boundary` 这些后缀
   在 223 个脚本里各自横跨 3–5 个证据等级。**不能按文件名推断强度。**

---

## 7. 可靠性与超时

- **超时保护基本缺失**（2026-09-12 实测）：`verify-v0-*.js` 中 **113 处** `spawnSync`/`execFileSync`
  里只有 **16 处**带 `timeout`（9 个文件），**97 处不带**；若含全部子进程形式则是 132 处中 116 处不带
  （26 个文件）。门禁 runner 自身也没有超时；`npm test` 是一条 `&&` 链。
  **一处 hang 仍可能挂住整条链。**
- `verify-v0-daily-workspace-data-runner.js:30` 有 `assert(Date.now() - started < 500)`，
  在 `npm test` 内，**按构造就是负载相关的**（机器忙时假红）。
- Electron 的耗时预算（如 `verify-v0-electron-e2e.js:42-45` 的 2500/700/800/100 ms）是挂钟断言，
  但这些不在 CI 里。
- Electron 用临时 CDP 端口，避免冲突；仍有小的 reserve→bind 竞态。

---

## 8. 加新测试的规矩（硬性）

1. 文件名必须是 `verify-v0-<feature>.js`，放在 `v0/tests/`。
2. **必须**在同一次改动里注册到 `v0/tests/0.4.0-test-gates.json`（或 legacy 基线），
   否则 `verify:0.4:registration` 会红——这是**闭世界双射**，注册清册与目录必须一一对应。
3. 断言用 Node 内置 `assert`；失败必须让进程非零退出。
4. 涉及破坏性操作/公开文件改动的，必须覆盖失败、陈旧 revision、项目切换、no-op、异步销毁。
5. 故障注入必须跨过它声称的生产边界（部分写入测试要真的先写字节再抛；
   committed-rename/fsync 测试要真的证明重启后语义）。
6. **不要**用源码文本 grep 冒充行为测试。如果确实只能做静态检查，
   `evidenceKind` 必须如实声明（这是 §6.4 待落地的规则 R3）。

---

## 9. 什么**不**是签收证据

以下任何一条单独变绿，都**不能**作为 App、Stage、candidate、作者验收或 release 签收：

- 任何 `-schema` 绿；
- 任何纯源码文本（G 类）绿；
- 任何 focused / component 绿；
- 任何打印了 `SKIP` 的 Electron 绿；
- 任何只有手敲它自己名字才能跑到的脚本的绿；
- 任何 `N/N` 数字（在 R1 落地前一律忽略）。

签收需要：真实生产边界证据 + 独立对抗性复审 + 明确记录残留 P2，且复审必须绑定一个干净的
本地 commit/tree。详见 `docs/0.4.0-EXECUTION-PROTOCOL.md`。

---

## 10. 修复进展（R1–R7）

| 规则 | 内容 | 状态 |
|---|---|---|
| **R1** | 报告诚实性：禁止未断言的 `${x}/${x}` 与硬编码 `N/N`；打印计数前必须 `assert.strictEqual(counter, EXPECTED_TOTAL)` | **已落地为棘轮门禁**（2026-09-12）：`npm run verify:test-report-honesty`，已进 `pretest`/`preverify`。**当前冻结债务：133 个同标识符分母 + 14 个硬编码总数 + 172 个未断言计数 + 9 个静默跳过 = 190 个文件**（明细见 `v0/tests/0.4.0-report-honesty-allowlist.json`）。门禁**阻止新增**，债务需逐批偿还 |
| **R4** | 跳过必须计数并使文件非零退出（除非显式 `WRITCRAFT_ALLOW_SKIP=1`） | **已落地同一门禁**（静态检测）+ **已修复 2 个真实缺陷**：`verify-v0-research-apply-transaction.js`（曾在断言失败后仍打印 "12/12 passed"）与 `verify-v0-delivery-image-decode-service.js`（曾在跳过一半 native 检查时仍打印 "8/8"）。其余 9 个为 Electron 门禁，其中 2 个在签收复审点名清单内，需重新复审后方可改 |
| R2 | 删除 `requiresGui` 豁免；用**执行闭包**替代"路径出现在 package.json 里"；解析 `verify.yml` 校验 CI 未丢门禁 | 未开始 |
| R3 | 把 `source-text` 提升为一等 `evidenceKind`，24 个纯静态脚本必须如实声明 | 未开始 |
| R5 | 门禁 runner 加 `timeout` + `killSignal`，失败标 `TIMEOUT` | 未开始 |
| R6 | 加一步"重建全部 helper 并比对 sha256" | 未开始（手工跑过，约 40 秒） |
| R7 | PDCA Plan gate 必须落盘符号级 `git log --all -S` 命中分类 | 未开始 |

**如何读这个棘轮**：

```bash
cd v0
npm run verify:test-report-honesty            # 门禁：任何新增违规即红
node tests/check-v0-test-report-honesty.js --report   # 打印逐文件债务清单
```

一条债务被修好后，必须**同时**从 allowlist 删除该条目——否则门禁会打印
"stale allowlist entries"，因为留着一条已修好的豁免会静默重新允许该缺陷回来。

在这七条全部落地之前，**请按 §4 的方式读结果，按 §5 的方式估计证据强度。**
