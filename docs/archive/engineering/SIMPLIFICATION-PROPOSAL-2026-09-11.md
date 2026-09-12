# WritCraft 代码精简提案（架构师只读审计，2026-09-11）

> 状态：**只读提案，不是派工文件**。不拥有派工权，不构成 checkpoint、签收或授权。
> 派工仍以 `docs/0.4.0-EXECUTION-PROTOCOL.md` 与 `v0/DEVELOPMENT-STATUS.md` 为准。
> 任何需要改动 CAS/revision/owner/project 绑定、单一权威规则或冻结合同的条目，**必须由所有者
> 显式授权威胁模型变更**；本提案没有、也不假设任何此类授权。
> 测量基线：commit `94ee3aa`（工作树干净）。审计全程未修改任何文件。

## 0. 规模口径校正（修正早期记录）

| 指标 | 早期记录 | 实测 @94ee3aa | 判定 |
|---|---|---|---|
| `src/main` | 115 模块 / 47,885 | 115 / **75,408** | ✗ Δ=27,523 |
| `src/renderer` | 49 / 20,683 | 49 / **20,683** | ✓ |
| `src/**` JS | 94,828 | **95,794** | ✗ Δ=966 |
| `native/*.c` | 8 / 23,629 | 8 / **23,771** | ✗ Δ=142 |
| `tests/verify-v0-*` | 221 / 91,060 | 222 / **92,302** | ✗ Δ=1,242 |
| Changes/History+Snapshot | ~33,000 / ~32 模块 | **27,363 / 27** | 定义相关 |

**根因**：`v0/release/` 是一个 **414 MB、未跟踪、已 gitignore 的陈旧 0.3.1 打包副本**，内含
完整的 `src` 拷贝（115 个 main 模块 / 74,393 行 + 全部 renderer）。任何朴素的
`find v0 -name '*.js'` 都会把它算进去，导致跨机器数字不一致。**建议本地删除该副本**
（环境清理，非仓库变更）。

## 1. 提案汇总（按优先级）

| # | 提案 | 影响 | 风险 | 时机 |
|---|---|---|---|---|
| P2 | 测试报表真实化：真分母 + 干掉 15 个硬编码总数 | ~181 行一行一改，0 测试体 | P2 | **现在** |
| P1 | 删除死掉的纯 JS WRCCHRJ2 journal + 其测试 | **−897**（521 生产 + 376 测试） | 保留并重接线则 P1；现状 P2 | 现在，需所有者点头 |
| P4 | 删除 `project-onboarding-service.js`(v1) + 其测试 | **−593**（336 + 257） | P2 | 现在，需所有者点头 |
| P3 | 合并重复的校验辅助函数 | **−~130** | P2 | 现在 |
| P6 | 为 63 个测试文件建一个极简共享 harness | **−~1,000–1,500** | P2 | 现在 |
| P8 | 补上 36% 的顶级 gate 缺口 | 0 行 | P2（证据完整性） | 现在 |
| P5 | 把 96 个内联 IPC 体从 `main.js` 抽出 | `main.js` **−1,865（−39%）**，他处 +~2,300 → 净 LOC ≈0 | P2（处理不当则 P0） | **A2a–A2c 之后** |
| P7 | 统一**两个活着的** C journal 实现（687+815=1,502 行） | — | **P0** | **需所有者决定** |

## 2. 孤儿模块——早期框架是错的，只有 13% 可删

方法：从三个真实生产入口（`package.json` main、`preload.js`、`index.html` 的 47 个
`<script src>`）做 require 图 + 引号路径边，并逐模块在 `codex/a1b-complete` 上核对消费者。
结果：**168 个 src 模块中 9 个不可达 = 7,041 行。**

**必须保留（待接线 checkpoint 依赖，共 6,184 行）**

| 模块 | 行数 | 依据 |
|---|---|---|
| `snapshot-service.js` | 385 | 分支 `main.js:21`（A2a） |
| `snapshot-compare-service.js` | 1,589 | 分支 `main.js:23`（A2b） |
| `snapshot-restore-service.js` | 1,078 | 分支 `main.js:26`（A2c） |
| `snapshot-delete-service.js` | 847 | 分支上尚无消费者（A2d 在前方）；**删它正是返工陷阱** |
| `snapshot-capability-store.js` | 592 | 分支 `main.js:25`；也被 delete-service 依赖 |
| `local-operation-service.js` | 309 | 分支 `main.js:20` |
| `author-acceptance-preflight-service.js` | 1,384 | 工具链：`scripts/prepare-author-acceptance.js`、`verify-release.js` 等 |

**真删除候选（857 行）**

- `changes-history-marker-journal.js`（521）——见 §3。
- `project-onboarding-service.js`（336）——已被
  `project-onboarding-v2-service.js` 取代；且
  `tests/verify-v0-project-onboarding-integration.js:68` **主动断言** main 不得
  `require('./project-onboarding-service')`，即项目已自行否决它。

附带测试质量：633 行（376 + 257）。

## 3. 重复 journal——是**三个**实现，不是一个

`changes-history-marker-journal.js` 写 `changes-history-transaction.json`
（`-schema.js:38`，用于 `:345`），magic `WRCCHRJ2`，A/B 双槽——与
`native/changes-history-artifact-helper.c:64,68` 格式身份完全一致。

1. `changes-history-marker-journal.js`——**死码**：`src/` 零消费者，只有自己的 376 行测试；
   分支上无任何 A2 提交消费它；且**没有 JS 回退路径**
   （`-native-lifecycle.js:11-12` 硬编码 helper 路径，无备选分支）。
2. `native/changes-history-artifact-helper.c`——**活的**：34 个 journal 静态函数 = **687 行**
   （占其静态函数行 27.5%）。
3. `native/public-markdown-create-helper.c`——**活的**：`JOURNAL_MAGIC` 在 `:93`，
   23 个 `create_journal_*` = **815 行**。

**切勿删除 `changes-history-marker-journal-schema.js`（2,309 行）**：它是活的，被 8 个以上
可达模块 require（含 `changes-history-reconciliation-service.js:14`）。只删 521 行实现 +
376 行测试。

**P7（两个活 C 实现）才是真正的隐患**，且架构师明确建议**现在不动**（位于 in-flight
A1b/A2 检查点与冻结 wire 内），列为需所有者授权的命名后续项。

## 4. `main.js` IPC 块——已量化，并附一处校正

`main.js` = **4,820 行**；IPC 注册 **101 `handle` + 2 `on` = 103**，位于 **2293–4797 =
2,505 行 = 52.0%**。用括号配对（非正则）抽取，handler 体共 **2,174 行**；**96 个是完整内联
体（2,147 行）**，仅 7 个是薄委派（27 行）。最大：149 行（`writcraft:chat`, 2843–2991）。
注入面有界：`assertTrustedSender`×82、`projectFailure`×78、`requireCurrentProject`×44、
`staleAiProjectResult`×36、`requireMutableProject`×26…一个 options 对象足够。

**校正**："后续功能都遵守 `*-handler.js` 模式"只对了一半——那 12 个模块（2,873 行）
**零个 `ipcMain` 调用**，它们是 service，注册体仍全在 `main.js`；而那 7 个已薄化的委派
恰好是最新的工作。**抽取后净 LOC 几乎不变**，是**可读性与 §7 合规**的胜利，不是瘦身胜利。
**必须等 A2a–A2c**（A2a 自己就要改 `main.js` +202 与 `project-service.js` +74）。

## 5. 错误码与校验仪式

`src/main` 原始 UPPER_SNAKE 字面量 **1,061 个 / 6,084 次**，但约 34% 是枚举噪声
（`COMMITTED` 232、`UNKNOWN` 173…）。真实错误码 ≈**709（估计）**，其中 **484 被消费**、
**225 全仓库无人引用（死目录约 32%）**。

真实重复：`valuesOf`/`descriptorValues` **12 个近似实现 / 181 行 / 149 调用点**；
88 个各自的 `function fail(code,message)`。

**精确形状校验层不是膨胀源**——约 **600–750 行 ≈ main 的 1%**，且在守护磁盘字节与跨项目权威
处是承重的（`project-service.js:120-136` symlink lstat、`:820-841` revision 复检、
`changes-history-reconciliation-service.js:68`+`:1215-1221`、`main.js:540-604` allowlist）。
**建议只合并 4 个逐字节相同的 `valuesOf` 包装 + 合并两个重叠的 delivery 错误消息表，其余不动。**
**不要清理那 225 个死码**：它们免费，而改名/删除会碰到 renderer 实际读取的跨 IPC `error` 字段。

## 6. 测试套件——怀疑对了一半：报表失真，但**没有静默变绿**

**125 / 222 个文件打印 `${passed}/${passed}`**——分母即分子，"N/N" 是算术上必然的，永不可能
表达失败。另有 **15 个** 打印手写字面量且无计数器（其中一个在 `:144` 打 `"1/1"`、在 `:400`
打 `"10/10"`；另一个打 `"28/28"` 而实际 93 个断言）。

**重要的反面结论（不要夸大给所有者）**：**退出码是诚实的**——零个"吞掉断言失败仍 exit 0"的脚本；
65 个 helper `catch` 全部 rethrow，7 个 `run().catch` 设 `process.exitCode = 1`，仅 4 个
`process.exit(0)` 且都被 `if (FAIL === 0)` 守卫。**所以没有静默绿**，缺陷在**人读的那行报表**。

其它：脚手架约 3,562 行（3.9%，已是有记录的下限）；断言密度健康（约 12,800 断言 /
每 100 行 14 个）；**fixture 干净**（5 文件、5 个不同 hash、零重复组）；**零未登记测试**
（`package.json` 缺的 42 个都在 `0.4.0-test-gates.json` 且被注册门禁强制）；
唯一真正死脚本是 `verify-v0-day3.js`。但 **81/222（36%）需要更窄的 gate，未串进
`test`/`verify`/`verify:full`**——所以"全套绿"这个说法夸大约三分之一。

**P2 是整份提案里性价比最高的一项**：~181 行一行一改、**零测试体改动、零安全影响**，
把套件自身输出从装饰变成可信。

## 7. 建议执行顺序

- **Phase 0（现在，与 A2 无关，纯 P2）**：P2 测试报表 → P3 合并校验辅助 → P8 gate 缺口 →
  P4 删 onboarding v1 → P6 共享 harness。无生产行为变化。
- **Phase 1（现在，需所有者一句话确认）**：P1 删死 journal + 其测试（−897）。
- **Phase 2（只在 A2a–A2c 落地后）**：P5 `main.js` 抽取。**依赖是真实的**。
- **Phase 3（A2 接线后）**：复查是否有 A2 待接线模块真的变冗余；**不要预先修剪**。
- **Phase 4（需所有者决定，P0）**：P7 统一两个活 C journal；任何跨 IPC 的错误目录削减。

## 8. 明确不建议触碰（及原因）

1. **~6,184 行 A2 待接线 service**——删任何一个都会重演本项目已吃过的"重复劳动"失败。
2. **11 个 `*-schema.js`（14,076 行 = main 的 18.7%）**——C wire 格式的手写镜像，无生成器；
   它们是 fail-closed `UNKNOWN` 边界。缩小它们属威胁模型变更，不是重构。
3. **`changes-history-reconciliation-service.js`（7,904 行）** 与 journal schema（2,309）——
   活的单一权威恢复面，且处于 in-flight A1b/A2 检查点。
4. **C journal CAS/fsync 代码**——定义上即 P0；P7 已标记需授权，未假设。
5. **精确形状校验整体**——约 1%，且守护 fail-closed 路径；对**已声明**威胁模型
   （同 UID 攻击者 = P2）而言它并非"仪式"。正确动作是合并重复，不是削弱检查。
6. **`project-service.js` 的 revision/symlink 逻辑**与 `projectFailure` IPC allowlist。
7. **任何冻结的 0.1.x–0.3.0 合同**。

## 9. 已核实 / 推断

**已直接核实**：全部规模计数；9 模块/7,041 行不可达集与逐模块分支消费者；
`changes-history-marker-journal.js` 可达性（src 零消费者）与格式身份；`main.js` 101+2 注册、
2,174 体行、96 内联/7 薄、注入符号计数、12 个 handler 模块零 `ipcMain`；测试计数
125 个 `${passed}/${passed}`、15 个字面量文件、零未登记测试、无静默绿；
`v0/release` 未跟踪且 414 MB；无 schema 生成器。

**由委派子代理核实且抽查一致**：错误码漏斗 1,061→709→484→225、
`valuesOf`/`descriptorValues` 12×/181 行、88 个 `fail()`、
~600–750 行校验估算、~3,562 行脚手架下限、63 个自带 harness 文件、221/222 可达。

**推断（已标注，未测量）**：A2d 将接线 `snapshot-delete-service.js`（来自执行协议 §5–8，
非来自代码）；早期数字来自 0.3.1 打包副本（一致但未证明）；抽取后 `main.js` 精确大小
（~2,960，取决于分组选择）；§6 的"虚假信心"排序；以及除四个已亲读的 `file:line` 之外的所有
"仪式 vs 承重"判断。

**干净结果（查过没问题，列出以免显得凑数）**：fixture 零重复；无未登记测试；无静默绿退出路径；
`src` 中无动态构造 `require()`（`main.js:127` 是唯一非字面量，且是显式测试 fixture 分支）——
故可达性结论不被动态加载推翻。
