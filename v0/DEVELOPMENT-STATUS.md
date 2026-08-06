# 笔触 · WritCraft 当前开发状态

> 最后更新：2026-08-06（`WRC-0.4.0-R1` 阶段 0 合同/基线冻结已完成，独立复审最终 P0=0、P1=0、P2=4，阶段 A 已解锁。阶段 0 产品源码、测试、脚本、`v0/package.json` 和 `v0/npm-shrinkwrap.json` 零修改；focused baseline：History 14/14、Diagnostic Export 13/13、SourceIndex 10/10、Citation 10/10、Graph Filter 17/17、Graph Workbench 14/14、Image Trash 21/21、PDF extraction timeout 3/3；这些不是 0.4.0 实现、真实作者或候选完成证据）
> 当前公开版本：`writ-craft@0.3.0`，npm `preview`
> 当前代码版本：`v0/package.json` 为 `0.3.0`
> 当前发布版本：`0.3.0` 透明 AI 协作（npm `preview:0.3.0`，GitHub `v0.3.0` prerelease，`latest:0.1.0`）
> 下一目标版本：`0.4.0` 证据与交付闭环（`WRC-0.4.0-R1` 已批准）
> 当前阶段：**0.4.0 阶段 0 已签收，阶段 A 当前；只实现 Main 项目快照、比较、Markdown 选择性恢复和安全删除权威。当前代码版本仍为 0.3.0，0.3.0 阶段 0–E 与发布已完成并冻结**

本文件只记录当前事实、开放风险和下一动作。0.1.x 的完整里程碑、红灯、测试数字和验收过程已归档到 [`docs/archive/development/DEVELOPMENT-STATUS-THROUGH-0.1.2.md`](../docs/archive/development/DEVELOPMENT-STATUS-THROUGH-0.1.2.md)，不得从归档旧 TODO 直接派发工作。

## 1. 权威入口

1. [`docs/ROADMAP.md`](../docs/ROADMAP.md)：当前版本顺序、0.4.0 范围和非目标。
2. [`docs/ROADMAP-0.4.0.md`](../docs/ROADMAP-0.4.0.md)、[`docs/EVIDENCE-DELIVERY-V1-CONTRACT.md`](../docs/EVIDENCE-DELIVERY-V1-CONTRACT.md) 与 [`docs/0.4.0-STAGE-0-INDEPENDENT-REVIEW.md`](../docs/0.4.0-STAGE-0-INDEPENDENT-REVIEW.md)：0.4.0 生效路线、冻结合同和阶段 0 签收；当前只可派发阶段 A 工作。
3. [`docs/ROADMAP-0.3.0.md`](../docs/ROADMAP-0.3.0.md)：已完成并冻结的 0.3.0 合同。
4. 本文件：当前代码、开放风险和下一动作。
5. [`docs/WRITCRAFT-PRD-V3.md`](../docs/WRITCRAFT-PRD-V3.md)：长期产品契约。
6. [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)：稳定架构与维护边界。
7. [`docs/INDEX.md`](../docs/INDEX.md)：按任务选择需要阅读的合同，禁止全量读取历史文档派工。

源码与可复现测试优先于文字快照。任何文档冲突先校准文档，再继续开发。

## 2. 0.1.2 已发布基线

- npm：`writ-craft@0.1.2`，`preview: 0.1.2`，`latest: 0.1.0`。
- registry shasum：`553bec35246b118ae5a47b2d4dd327c16c171029`。
- GitHub prerelease：`https://github.com/MaxHou-infinity/WritCraft/releases/tag/v0.1.2`。
- annotated tag `v0.1.2` 解引用到发布提交 `395b863`；文档收口提交为 `95f923b`。
- 不提供未签名 App/ZIP；独立 macOS App 签名与公证不是当前路线。
- 0.1.2 已冻结。后续生产修复使用新版本，不回写或重新发布 0.1.2。

已签收的用户能力：

- 本地多文件项目、`edit.md` 项目 Prompt、文件树、标签和恢复；
- 项目卡、Inline `⌘K`、Chapter、Chat 与 Context Inspector；
- Changes/Diff、History、冲突阻止和 Safe Undo；
- 空项目结构规划、已有稿件写作导航和统一写作任务流；
- Sources、Research 高级独立流程、Graph v2 与 Issue→Changes；
- 图片生成、评分、prompt-free 插入、保留和安全删除终态；
- Markdown 回收区、诊断预览、npm Developer Preview。

以上能力除非 0.2.0 生产源码直接影响，不重复进行 0.1.2 的项目卡、接受/拒绝/撤销或付费作者验收。

## 3. 0.3.0 已完成执行事实

- 阶段 0：当前源码核对已完成。旧 Project Plan 用户运行时已在 0.2.0 阶段 0 物理移除；现存 `chapter-generation-plan/v1` 仅属于 Chapter 内部区块规划，不得删除或误归类为退役 Project Plan。
- 阶段 0：现有 `context-selection`、Main `context-resolver`、Context Inspector、`unified-writing-task-service` 和 Navigation 的取消/超时机制均已确认，0.3.0 只补统一入口和跨模块状态，不重复造解析器或 Key 存储。
- 阶段 A：新增 Main-only `ai-task-state-service.js`，统一 task/attempt/owner/project/revision、15 秒取消、60 秒硬超时、迟到结果和项目切换失效；Navigation 动作已接入，Chat/Chapter/Research/Graph/Changes/图片入口已通过 `runAiRequest` 声明任务 kind/target。
- 阶段 B：新增 Main-only `context-catalog-service.js` 与窄 IPC；文件、文件夹、章节、段落候选已从真实树和 revision 快照生成，来源/实体仅在明确搜索前缀时有界索引。Renderer 新增不重建输入节点的 `@` 补全；候选由 Main 签发短期 `@ref:<catalog>:<candidate>` 引用，提交时必须通过当前 project/revision 校验，过期或未知引用 fail-closed。Chat、导航目标和 Changes 指令已接入；候选不返回正文、root 或 capability。真实项目 focused 验证 1/1 与 Context Catalog real Electron 1/1 均通过，确认来源 revision、实体 ID、章节 revision、有效引用进入统一项目上下文，edit.md revision 漂移、foreign project identity 和 TTL 过期会失效；Chat UI 显示“上下文候选已过期，请重新选择”。目录同时覆盖 `person/place/organization/variable/concept/event/datum` 等图谱节点，并按 `entity/source` 前缀解释查询。真实作者五入口现均输出同一 Main-owned Context Manifest v2 envelope。
- 阶段 C：Chat 既有 Context Resolver 继续作为权威入口；Navigation、Chapter、普通 Changes 和 Research 已接入同一 `compileEditPrompt` 有界编译结果。Research 的来源卡片仍由用户显式选择，但模型同时收到 Main 编译的 edit.md 项目 Prompt，并在 Context Manifest 中披露 edit.md revision/预算；不改变独立 Research 的来源与写入边界。
- 阶段 D：Renderer 已挂载统一任务进度视图，Main 的 Chat/导航/Chapter/Research/Graph/Changes/图片入口声明真实业务阶段；任务服务严格要求 `attemptId` 字段（未提供时由 Main 生成），并在成功、失败、取消、超时和项目切换后清理 owner。项目卡真实 Electron 4/4 通过，覆盖冷启动、长正文滚动、严格 onboarding 审阅和初始文件二阶段确认。
- 阶段 D：同一 profile 的 API Key “保存 → 完全退出 → 重启 → 状态恢复 → 发起请求”真实 Electron 专项已通过；设置页密码框仍按安全设计为空，状态行是配置真相。此前的 P1 记录保留为历史作者反馈，不再作为当前未决缺陷。
- 本轮真实红灯已分类并修复：快速失败导致进度提示一闪而过、项目尚未 ready 时项目卡提前打开、严格 task 合同缺少 `attemptId` 键、成功提案后复用旧 review 草稿，以及 E2E 夹具未跟随 readiness/阶段数合同更新。修复后 Onboarding focused Electron 为 4/4，相关动态 Renderer 为 30/30，workspace draft owner 为 4/4。
- 阶段 A/D 最新真实作者路径（2026-08-04）：在同一稳定 profile、已配置 `sk-cp-` Key 的隔离副本中，Navigation 生成耗时约 9.1 秒并生成建议；点击“处理这个建议”后约 15 秒内在正文编辑区显示 1 项 Diff，界面明确“尚未写入；接受后才会修改文件”。退出审阅后明确保持零写入。随后真实点击“停止整理”可在约 1 秒内终止请求，正文不变；取消结果已收口为 `REQUEST_ABORTED`/`cancelled`，不再伪装成通用失败。
- 本次真实路径还定位并修复一个 P1 根因：Navigation 把含绝对路径和 JSON 标点的内部 lease key 误作 AI task owner，导致 provider 尚未调用即 28–37ms 失败。现改为 `navigation_<attemptId>` 有界 owner，并为返回式 `REQUEST_ABORTED` 保留 cancelled 终态；Main wiring 8/8、Navigation service 专项通过，修复后的真实生成与 Diff 已验证。
- 2026-08-04 中间回归记录：一次 `npm test` 通过，获批 GUI 环境一次 `npm run verify` 退出码 0；本轮新增写作导航服务 31/31、AI task 7/7、进度 Renderer 3/3、Main wiring 8/8、Context catalog 2/2、真实项目 Context catalog 1/1、Context Catalog real Electron 1/1（含短 TTL 过期和 Chat 恢复 UI）、Context autocomplete 2/2，API Key 同 profile 重启 1/1、watcher Main/IPC 3/3、Chat 任务进度 focused Electron 1/1。统一写作任务 focused Electron 1/1 另行验证一次主要点击到正文 Diff、拒绝/接受/Safe Undo；随后阶段 E 已补齐跨入口作者验收、独立复审与最终完整回归，不能再把这条中间记录当作当前未完成状态。
- 阶段 E 新增真实作者跨入口专项 1/1：从所有者指定的 `WRITCRAFT_E2E_AUTHOR_PROJECT` 源稿经生产 author-acceptance copy transaction 创建 disposable derived copy，仅在副本新增 `chapters/author-e2e.md` fixture；真实 Electron 完成 Chat（项目 Prompt + 当前文件 Context Chips）→ Navigation（一次主要动作）→ 正文 Diff 零写入→外部改动后的冲突阻止→退出审阅重试→接受写入→History Safe Undo。专项还证明源稿 Markdown 快照前后一致、AI fixture 没有真实 HTTP(S) 请求；首轮 Chat 上下文断言过窄和二次审阅状态等待红灯均已保留并校准后通过。
- 2026-08-04 统一任务 focused Electron 1/1：在隔离临时项目和本地 AI fixture 中验证单一“处理这个建议”主动作、正文内 Diff、预览零写入、拒绝零写入、接受后写入、History 和 Safe Undo；未发送真实稿件或 Key。该专项不能替代 Chat/Chapter/Research/Graph/图片的跨入口作者验收。
- 阶段 E 作者验收（2026-08-05）：所有者提供的作者目录包含私有 `.writcraft/author-acceptance-copy.json`，直接重复 copy 首轮以 `COPY_MANIFEST_CONFLICT` 被安全预检拒绝；未删除或改写源目录，测试仅在临时 staging 排除该私有防嵌套标记后再由生产 copy transaction 创建副本。获批 GUI 环境 `e2e:electron:author-cross-entry` 1/1 与 `e2e:electron:author-affected` 1/1 均通过：Chat/Navigation/Chapter/Research/普通 Changes 的 Provider 边界 edit.md revision 漂移均丢弃旧结果，Markdown 零写入；并覆盖 Chat 正常/取消/60 秒硬超时、Chapter、Research、Graph、图片预览/评分/废纸篓/插入正文、正文 Diff、冲突阻止、接受和 Safe Undo；来源不足“添加来源”恢复、跨项目 A→B 迟到结果丢弃及 A/B 零写入继续通过。五入口 Context Manifest v2 对照和相对路径/正文不泄露专项通过，fixture 无真实外部请求，源目录 Markdown digest 前后一致。
- 本轮保留的首个回归红灯是 `verify-v0-sources-race.js` 测试夹具未提供 Renderer 新增的 `window.setTimeout`；该夹具已补齐 `setTimeout/clearTimeout`，定向 Sources race 5/5 通过。修复后当前 worktree 的完整 `npm test` 退出码为 0。
- 本轮 `npm run verify` 首个红灯为 `verify-v0-workspace-location.js:308` 的 300-file 内存 quick-open 性能断言（实测 4,968.5ms > 1,500ms）；未修改产品代码迎合单次测量，保留为当前验证环境/性能方差证据。随后仅重跑该定向用例通过，证明当前红灯具有非固定时序/环境方差，不能用该绿灯覆盖首红。
- 获批环境真实作者 `author-affected` 首轮红灯发生在图片插入后的 Safe Undo：插入已成功，但该 workspace persistence 路径不创建 Changes History 记录，因而没有图片专属 latest undo 卡；首红保留并已将断言校准到真实合同（图片只验证允许写入边界，Chapter/Research/Graph 验证 Safe Undo），不能把图片插入误报为有 History Undo。
- 当前 `npm test` 首轮未退出的首红已定位并修复：`sources-view.js` 的 Research 来源打开观察与 15 秒 fallback timer 在 Promise 结束后未清理，导致 Sources race 虽 5/5 通过但进程滞留；现已绑定 owner、清理 observation/timeout timer，定向 Sources race 5/5 约 0.06s 退出，修复后完整 `npm test` 退出码为 0。Research manifest 改动后的完整 `npm test` 与获批 GUI `npm run verify` 也均以退出码 0 完成。

## 4. 当前开放项

### 0.4.0 阶段 0 合同/基线冻结（已完成）

- `WRC-0.4.0-R1` 已获所有者确认，§11 目标模式文本已另行提交；阶段 0 已完成，阶段 A 已解锁，B–E 尚未开始。
- 生效合同复用 History、Diagnostic Export、SourceIndex、Graph v2 和 Image Trash 的既有边界，但不把它们误报成项目快照、作品导出、多视图或健康审计。
- 已确认四项：DOCX 单格式；snapshot 不删除新增文件且只恢复 Markdown；Graph 四个共享证据视图；alt/caption 与已保留素材清理默认不纳入必做。
- 新增 `docs/EVIDENCE-DELIVERY-V1-CONTRACT.md`，冻结 Snapshot allowlist/容量/私有存储、创建和删除三态事务、比较与全有或全无的 Markdown 选择性恢复、八分量 delivery authority、五类引用健康、Citation shared 单一权威、DOCX 子集/OOXML/安全保存、Graph 四投影、本地 operation owner 和 Pages 14.4（7043.0.93）真实渲染基线。
- 阶段 0 首轮只读合同审计保留为 P0=0、P1=10、P2=3：P1 覆盖启动状态、Snapshot/schema/事务、恢复、delivery authority、DOCX、OOXML、健康/Citation、Graph 和本地长任务边界；已写回冻结合同，待新的独立复审确认。P2 保留当前文档 dirty worktree、Electron 沙箱 SIGABRT/获批环境版本探针差异，以及 0.3.0 大型 harness/quick-open 历史首红。
- 阶段 0 当前运行基线（产品源码、测试、脚本与 `v0/package.json` 零修改）：完整 `npm test` 退出码 0；沙箱内首次 `npm run verify` 在 `verify-v0-dom-sanitizer.js` 以 `Electron exited null` 红灯退出，原命令在获批 GUI 环境退出码 0，首红保留且不归因于产品代码。获批环境 `WRITCRAFT_E2E_FORCE=1 npm run e2e:electron` 连续两次在前 6 个阶段通过后，于“普通 Markdown 可见回收区列表”等待处同点红灯，并同时报告 watcher unavailable/`HOME_SNAPSHOT_TIMEOUT`；这是可复现的当前大型 harness 基线，不能宣称 38/38 全绿，也不在文档阶段修改产品。独立真实 Main/IPC watcher 专项 3/3 通过，证明确定性 watcher 边界可启动。
- Computer Use 已从 Pages 的真实 About 窗口读取 `Pages 14.4 (7043.0.93)`；WritCraft 使用单独临时 profile 启动并被系统注册为运行应用，但读取其 AX app state 连续返回 Computer Use server timeout `-10005`。该隔离进程与仅由本轮创建的临时 profile 已清理；自动化真实 Electron 证据与 Computer Use 工具超时分别记录，后者列为阶段 0 环境 P2，不能冒充 App UI 通过。
- 健康 marker 复用现有 Main `consistency-engine` 的 `【待补来源】`、`[待补来源]`、`[citation needed]`、`<!-- citation-needed -->` 四种语法；阶段 B 只把既有 `evidence_gap` 适配为 `missing_source`，不创建第二套扫描器或 marker parser。
- 阶段 0 最终稿首轮独立复审保留为 P0=0、P1=7、P2=3，明确阻止进入阶段 A。P1 为 `.markdown` 兼容、digest preimage、完整嵌套/事务/public schema、私有 stage/quarantine 原子所有权、五类 health binding/reason/severity、既有 Unicode citation/URL 兼容，以及 Markdown/图片 parser/预算权威；现已逐项写回合同，等待同一复审员定点复核。P2 为沙箱 DOM Electron 环境红灯、完整 Electron harness 连续同点红灯和 WritCraft Computer Use AX `-10005`；另把恶意同 UID 进程主动篡改 `0700` 私有 snapshot 存储明确列为 V1 主机账户攻陷残余，不再宣称由随机名或事后 stat 关闭。
- 第二轮定点复核保留为 P0=0、P1=5、P2=4：P1 指向 bundle/digest payload/数值上限仍非 exact、public Diff 与逐边界分页请求矛盾、Graph→Source binding 和 fragment fixture、真正图片 decoder、DOCX 直接创建 final/错误假设保存面板返回父 fd。现已冻结 bundle golden bytes 与字段上限、operation-specific request、同 graph identity 的 source binding table、ImageIO 强制 decode worker，以及 Main-only save path→可信 filesystem-root traversal→同目录 hidden stage→`RENAME_EXCL`→final reconciliation；待第三轮独立复核。P2 四项保持不变。
- 第三轮定点复核保留为 P0=0、P1=5、P2=4：剩余 P1 为 source/bundle object digest 双语义、Graph binding digest 未定域、public 标题标签与正文例外文案、list/delete/artifact capability 签发链、ImageIO 最大合法资源闭包和任意目标保存的持久化 binding/reconciliation。现已拆为 `sourceObjectIdentityDigest`/`bundleObjectDigest`，冻结 binding digest 域，明确 heading/label 为有界 metadata，补齐 list/delete preflight/artifact public envelope，收敛 DOCX 到 40 图并以双 worker/1 GiB/100 秒闭合，以及新增 private save target binding、stage/expected-final/published identities 与重启三态算法；待第四轮独立复核。
- 第四轮定点复核保留为 P0=0、P1=3、P2=4：P1 为 bundle/save identity 摘要仍缺 exact preimage、capability `selectionDigest` 未按 kind 冻结、ImageIO 误写成不存在的独立 snapshot object fd。现已补齐 bundle object framing、save volume/parent/stage/published identity exact payload，按 compare/restore/delete/export/artifact 冻结 selection payload，并将图片读取改为 verified bundle fd + exact entry offset/length/digest 的 `pread`；save recovery 的“只匹配 stage”也改为 cleanup + final 不存在重检 + 目录 fsync 后才发布 `UNCOMMITTED`。待第五轮独立复核。
- 第五轮定点复核保留为 P0=0、P1=2、P2=4：仅余 Graph source `bindingId` 是否等于完整 digest、entry digest 字段名笔误，以及 macOS `fsid_t` 有符号编码。现已明确 `bindingId =` 3.1.4 完整 `sha256:` digest、统一 `entryBindingDigest`，并把 `fsid0/fsid1` 冻结为 int32 原值的有符号十进制字符串。
- 第六轮定点复核最终为 **P0=0、P1=0、P2=4**，确认阶段 0 可以退出、阶段 A 可以开始。四项 P2 为：沙箱 DOM Electron 红灯/获批 GUI `verify` 绿灯的环境差异；完整 Electron harness 两次同点红灯；WritCraft Computer Use AX `-10005`；恶意同 UID 主动篡改私有 snapshot store 的主机账户攻陷残余。完整签收见 [`docs/0.4.0-STAGE-0-INDEPENDENT-REVIEW.md`](../docs/0.4.0-STAGE-0-INDEPENDENT-REVIEW.md)。
- 草案首轮独立复审保留首红：P0=0、P1=6、P2=4，指出 PRD 发布状态、D1→R1 顺序、图片恢复边界、snapshot 事务、统一 delivery authority、DOCX 真实渲染，以及 focused evidence、诊断导出隔离、citation 权威和 Graph 连续性缺口；均已写回草案。
- 第二位独立复审首轮为 P0=0、P1=1、P2=2，发现当前项目图片漂移与 exact-snapshot 导出语义冲突，以及 snapshot 删除事务和 `deliveryAuthority` 字段歧义；修订后由该复审员定点复核为 P0=0、P1=0、P2=0。该结论证明审阅稿可被批准为 R1，但不代表阶段 0 已完成或实现已启动。
- 路线图确认后的旧文档治理独立复审保留首红 P0=0、P1=1、P2=0：根 `AGENTS.md` 仍可从 0.2.0 阶段 0 派工。现已校准当前 Preview、冻结反向依赖与 Project Plan 清理事实，并加入 `WRC-0.4.0-R1` 等待目标模式门禁；定点复核最终 P0=0、P1=0、P2=0。

### 0.3.0 发布前保留证据（已冻结）

- 统一任务条已完成基础 Renderer 接入；Chat/Navigation/Chapter/Research/Graph/Changes/图片作者路径和入口取消、Chat 硬超时已在真实作者副本通过；阶段 E 独立复审和公开 Preview 发布均已完成。
- Navigation 单入口的真实生成、局部 Diff、退出审阅零写入和取消已通过；Chat/Chapter/Research/普通 Changes/Graph/图片的作者路径、迟到结果隔离和零写入也已逐项验收。
- `@` 来源/实体候选已有 Main 目录和 request-bound ID 合同；真实项目候选、Main IPC 的 revision 漂移、foreign project identity、TTL 过期及 Chat 恢复 UI 已由 focused Electron 1/1 验证，五入口作者路径均使用同一 Context Manifest v2。
- `edit.md` 编译器已有跨入口实现；真实作者已对照 Chat/Navigation/Research/Chapter/Changes 的统一 revision、预算、遗漏/截断语义，并通过 Navigation/Chapter/Research/Changes 的旧结果丢弃；compile-invalid 不再回退发送原文。
- 阶段 E 已完成两条真实作者 Electron 证据：`author-cross-entry` 1/1 与 `author-affected` 1/1；覆盖 Chat → Navigation → Diff → 冲突阻止 → 接受 → Safe Undo，以及 Chapter、Research、普通 Changes、Graph、图片、五入口 edit.md revision 漂移、Chat 取消/60 秒超时、Navigation/Chapter/Research/Graph/图片取消、来源充足/不足“添加来源”双分支、添加来源后原 action identity 保留并回到 review、跨项目 A→B 迟到结果丢弃、A/B 零写入边界。Manifest 完整字段语义矩阵已由 `verify-v0-context-manifest.js` 4/4、服务专项和真实作者对照覆盖；独立复审已签收 P0=0、P1=0、P2=3，0.3.0 已进入公开 Developer Preview。

### 0.3.0 发布事实（2026-08-05）

- npm：`writ-craft@0.3.0` 已发布到 `preview`；registry 反查为 `preview: 0.3.0`、`latest: 0.1.0`。
- npm 完整性：shasum `c3294a3f106119096751f8c2b67afa55e91bd702`；公开 tarball 为 `https://registry.npmjs.org/writ-craft/-/writ-craft-0.3.0.tgz`。
- GitHub：`main`、annotated tag `v0.3.0` 与 prerelease 已生效；Tag/Release commit 为 `a747683`，Release 为 `https://github.com/MaxHou-infinity/WritCraft/releases/tag/v0.3.0`。
- 公网隔离安装验证：`WRITCRAFT_NPM_PREVIEW_PACKAGE_SPEC=writ-craft@preview` 的 `verify:npm-preview:installed` 通过 **2/2**，覆盖公开 tarball、Main `did-finish-load` IPC、profile 隔离、信号转发和清理；未打开作者稿件。
- 发布边界：这是 macOS npm Developer Preview；未移动 `latest`，未分发新的 App/ZIP，也不宣称稳定版。

### P0 / P1

- 0.3.0 独立复审 P0=0、P1=0；当前无工程阻断项。0.2.0 的 P0/P1 结论仅作为历史基线保存。

### 新增作者反馈：API Key 重启后似乎需要重输（2026-08-04，已关闭）

- 源码事实：`src/main/api-key-config-service.js` 已实现原子持久化、schema 校验和 `0600` 权限；`src/main/user-data-service.js` 默认将 profile 固定为 `~/Library/Application Support/WritCraft`，显式 `--profile` 则按设计隔离。
- 本机只读核对：稳定目录及两个历史目录均存在 `ai-config.json`，权限 `600`，Main `publicStatus` 均返回 `configured: true`；未读取或输出 Key 明文。
- 结论：固定同一启动方式与 profile 的真实 Electron 专项已验证保存后完全退出、重启、状态恢复及一次请求均成功；未读取或输出 Key 明文。输入框重启后为空是安全设计，不再视为丢失。

### 0.3.0 本轮真实 Electron 回归红灯（2026-08-04）

- 受影响 focused 路径已通过：项目卡真实 Electron 4/4、API Key 同 profile 1/1；AI 任务 7/7、进度 Renderer 3/3、Navigation 生产集成 10/10、Research Main 13/13 + 15/15 + 12/12、Research Renderer 13/13。
- 完整 `npm run e2e:electron` 首轮在前 12 个阶段通过后，于 Changes/History recovery 之后等待“一个统一 Writing Navigation 建议”超时；第二轮在更早的“普通 Markdown 可见回收区列表”等待处超时。两个红灯发生在不同阶段，且对应专项均全绿，当前归类为大型 Electron harness 的非固定时序 P2，不宣称完整 38/38 全绿。
- 完整 `npm test` 与获批 GUI 环境的 `npm run verify` 均通过；沙箱内 DOM sanitizer 的 `Electron exited null` 仅记录为环境红灯，原样转入非沙箱后通过。两条作者隔离副本脚本的独立真实验收已完成，不能把这两条 focused 绿灯扩写成大型 38 阶段 harness 永久稳定。
- 本轮完整 `npm run verify` 在获批 GUI 环境再次通过（退出码 0）；`npm run verify` 不包含完整 38 阶段 Electron harness，既有 `npm run e2e:electron` 不同时序红灯仍按 P2 保留，未用本次源码回归绿灯覆盖。

### 0.2.0 阶段 F 候选事实（2026-08-03）

- 当前会话 pending review 的真实 Electron 动态矩阵 3/3 通过：覆盖公开 `review_*` 身份 hydrate、丢弃、接受/拒绝、residual 新身份、旧身份失效、真实 TTL 过期、首页入口消失和正文零写入。Renderer 的 public ID 仅用于审阅决策，真实 ChangeSet capability 始终由 Main 解析。
- 作者授权源稿通过生产 copy transaction 创建隔离副本 `WritCraft-0.2.0-作者验收-1`：20 个 Markdown 文件、12 个正文文件；源摘要在复制前后完全一致。Computer Use 在独立 profile 中完成“首页查看状态 → 继续写作定位 → 查看当前文件大纲 → 返回首页”，无 AI、无付费调用，源稿和副本的非私有文件最终逐文件一致。
- 真实旅程发现并修复 P1：从首页打开最近文件时正文已经切换，但大纲仍描述旧文件。现在 Home 打开动作必须等待目标文件大纲刷新，再恢复正文定位；Computer Use 复验确认目标标题出现、旧大纲消失，返回首页后继续位置和 pending=0 正确。
- 最新源码 `npm test` 与非沙箱完整 `npm run verify` 通过；待审 focused Electron 3/3 通过。Daily Workspace focused 复跑再次在“外部文件 watcher 大纲刷新等待”处红灯；该非固定 harness 时序问题已保留为 P2，未用重跑绿灯覆盖。确定性 watcher/owner 专项、真实作者 UI 旅程和此前 focused 证据均通过，未形成稳定产品回归。
- 最终独立复审：P0=0、P1=0、P2=2，可进入候选。P2-1 为缺少“`refreshOutline` await 期间切项目”的 mutation-sensitive 专项，生产实现已有 refresh 后 owner 复核；P2-2 为通用 store 配置超过 10 项时 public projection 可能隐藏最旧映射，生产 Main 上限与 projection 同为 10，当前不可触发。两项均允许候选，未来触及对应代码或提高上限时必须先补合同和反例。
- 所有者于 2026-08-03 完成唯一一次最短主观旅程并明确回复“验收通过”。至此工程门禁、真实作者客观旅程和作者主观体验均已关闭，0.2.0 候选验收完成。随后已授权并完成 GitHub main 推送、`v0.2.0` Tag、GitHub prerelease 及 App/ZIP 上传；当时的 npm OTP 门禁是历史现场，0.2.0 不再单独发布，也没有待执行 OTP 动作。

### 0.2.0 发布执行记录（2026-08-03）

- 所有者已明确授权：执行 npm `preview`、GitHub 推送、`v0.2.0` Tag/Release，并上传 App/ZIP 产物。
- 发布前自动门禁：`npm test`、非沙箱 `npm run verify`、`npm run release:verify`、`npm audit --omit=dev` 均通过；npm tarball dry-run 为 `writ-craft-0.2.0.tgz`，140 个文件，683,229 bytes。
- 本地 macOS 产物：`v0/release/WritCraft-darwin-arm64.zip`；当前为 ad-hoc 本地签名、未公证，不宣称 Apple Developer ID 分发能力。
- 本节是 0.2.0 发布现场的历史记录；其能力已随 0.3.0 Preview 交付，不再等待 registry/dist-tag/提交补录，也不得从本节派发任何外部发布动作。

### 0.2.0 阶段 E 当前事实（2026-08-03）

- `writcraft.workspace/v2` 已实现并由 Main 独占迁移写权限：合法 v1 原子迁移；损坏、未来 schema 或失效路径安全降级且不覆盖原记录。保存/读取均绑定 exact `projectInstanceId`；保存 generation 由 preload 单调签发并由 Main 拒绝旧请求。
- 标签、当前文件、caret、selection、scroll、当前/折叠大纲和最多 32 项 `returnStack` 已持久化。返回时 revision 相同精确恢复，漂移时只恢复安全位置；临时 pending capability/location 不落盘。
- 项目首页、深跳与返回动作均绑定项目实例和 operation generation。真实 IPC 反例覆盖同项目旧异步保存落后于 close flush、保存执行中切换项目、旧项目 load/save、返回动作与首页 resolve/back 跨项目迟到；均不得覆盖新项目状态。
- 真实 Electron 性能复验：50 文件五次 `576.8 / 583.3 / 588.9 / 717.6 / 1169.4 ms`，max `1169.4 ms ≤ 1.5 s`；300 文件五次 `578.1 / 596.6 / 619.1 / 620.0 / 732.1 ms`，max `732.1 ms ≤ 3 s`。每次均为 fresh project/profile/process。
- 真实 `webContents.setZoomFactor(2)` 下 focused 工作区 2/2 通过，覆盖 Home → Continue → Return、`⌘P` 焦点/关闭、窄窗口键盘和项目切换 owner；不是用 deviceScaleFactor 冒充。
- `npm test` 与完整 `npm run verify` 通过；真实 Electron 曾完成 38/38 全绿。随后大型 harness 在不同旧路径出现三次非固定红灯（CDP evaluate、Chat fixture watcher 恢复、Recent return 等待），且曾在消除测试 sentinel 与真实滚动值冲突后再次 38/38 全绿；最后一次 owner 错误优先级修正后 focused zoom 2/2 通过，但全量复跑又在 Recent return 等待红灯。按纪律保留为 **P2 harness 时序不稳定**，不能用绿灯覆盖，也未发现稳定产品断言回归。
- 独立复审最终 P0=0、P1=0、P2=1。P2 为跨项目 in-flight 保存反例缺少 Main-side “delay 已进入” latch，当前依赖 Electron 同 sender IPC 顺序；实现本身已在 await 后重新取得当前项目并动态通过。阶段 F 若触及该 harness，应补 fixture-only latch，提高反例 mutation sensitivity。

### 0.2.0 阶段 D 当前事实（2026-08-03）

- 中央主工作区新增项目首页；左侧活动栏提供常驻入口。已有项目仍恢复上次编辑位置，新项目进入首页。首页只消费 Main `writcraft.project-home/v1` 快照，不在 Renderer 扫描正文或推断完成度。
- 首页包含继续写作、当前会话待审 Diff、最近修改、Graph/显式来源缺口和正文一览；所有入口都通过 Main stable locator 解析。revision 在 resolve→open 之间漂移时只重解一次，持续漂移明确失败；首页可响应 tree/current-file 权威变化重新加载。
- 新增 pending review 无 capability hydration：preload/Renderer 只传 public `reviewLocationId`，Main 负责 hydrate/apply/discard 并把 residual review 重新映射为新的 public location。过期、项目切换、迟到 hydration/discard 和 discard 失败均不污染新项目或伪报成功。
- 真实 Electron focused 2/2 通过，动态验证首页返回精确文件/光标、继续写作和最近修改卡片跳转；`npm run verify:daily-workspace`、Changes review UX 12/12、`npm test` 均通过。
- 完整 `npm run verify` 沙箱首跑在真实 DOM sanitizer 以 Electron `code=null` 退出；同一命令在获批非沙箱 GUI 环境原样复跑通过。误用旧环境变量的一次 38 阶段 harness 在首页阶段通过，随后于既有 Graph 冷重建时序断言红灯；保留为既有大型 harness P2，不归因于首页产品代码。
- 获批 GUI 环境曾完成一次完整 Electron 38/38；随后两次原样重跑分别在普通 Markdown 回收区列表和 Graph Issue undo recovery 超时。失败位置不同且专项回归全绿，按非固定时序 P2 保留，不能把一次 38/38 或后续 focused 绿灯写成完整 harness 永久稳定。
- 新增 `npm run e2e:electron:ai-task-progress`：真实 Electron Chat 入口 1/1 证明 Main 的准备/阶段/完成事件进入共享任务条，终态显示“已完成”；使用本地注入夹具，无真实网络和稿件外传。
- 独立复审先后发现 hydration owner、discard 失败误报、返回光标缺失和跨项目 discard 迟到污染等 P1，均已修复；最终 P0=0、P1=0。
- 阶段 D 当时保留的 pending 动态矩阵缺口已在阶段 F 以真实 Electron 3/3 关闭。超过 10 项 projection 的通用配置风险仍作为允许候选的 P2 保留；生产 Main 上限与 projection 同为 10，当前不可触发。

### 0.2.0 阶段 C 当前事实（2026-08-03）

- 新增独立 `writcraft.document-outline/v1` 投影：Main 公开当前文件 revision、稳定 section ID、层级/父级、occurrence、UTF-16 区间与不透明 locationId；最多 1,000 标题、512 KiB，最终 partial envelope 按完整字节预算。
- 左侧 Explorer 已加入“当前文稿”标题树；支持层级缩进、会话内折叠、树键盘操作与 revision-bound 当前区块高亮。折叠持久化明确留给阶段 E 的 workspace/v2 迁移，没有向 workspace/v1 静默写新字段。
- 顶层 `⌘P` 快速打开已接通 file/heading/entity/issue；结果按类型分组，保持同一 input 节点、焦点、active descendant，IME composition 期间不查询，项目切换与迟到查询/激活结果均由 owner 丢弃。
- `pending_review` 的 Main 公开投影与 resolve 仍保留，但 Renderer 快速打开暂不列出。原因是 Renderer reload 或同会话多份 review 需要 Stage D 的无 capability hydration；当前宁可不展示，也不把“Main 仍有效”误报成可打开或已过期。
- 激活同一未保存/冲突/已删除正文时 fail-closed；打开文件后 revision 漂移最多回 Main 重解一次。大纲不从 breadcrumb 猜层级，不建立第二套文件扫描。
- 已通过：`npm run verify:daily-workspace`、workspace 持久化 10/10、Changes review UX 12/12、完整 `npm test`、真实 Electron focused 2/2。真实 Electron 已验证大纲目标的 Main source offset、编辑器 caret offset 和 `aria-current` section ID 精确一致，以及 `⌘P` 输入节点/焦点/方向键选择。
- 真实 IME 首跑保留红灯：composition 期间，组合开始前的在途查询曾迟到更新状态。修复为 `compositionstart` 同步失效旧 request owner 后，真实 Electron 复跑 2/2 通过，并验证 input 节点、焦点和状态在 composition 中不重建，compositionend 后才查询。
- 独立复审首轮发现 512 KiB 尾部 +1 byte、激活 owner、workspace/v1 漂移、滚动/revision 高亮和 pending 假可用等 P1；已逐项修正或按阶段边界从 Stage C UI 移除。新增 H1→H3→H4→H2 父链、精确 512 KiB 与 +1 byte 回归；最终复审 P0=0、P1=0、P2=0。
- 阶段 C 已关闭：真实 Electron 已验证外部磁盘修改后正文与大纲同步刷新；720px 下大纲抽屉可由键盘进入、激活和退出并恢复焦点；300 文件冻结 inventory 的 100 次逐键式查询不触发第二套扫描并通过 1.5 秒测试上限。
- 最终复审曾发现外部 watcher 回调跨 await 切项目时可能污染新项目及旧恢复对话框的 P1。现以 `projectInstanceId + currentPath + sequence` owner 约束 tree/edit/read/recovery 全链，并在项目进入开始时同步作废旧 callback；复审关闭为 P0=0、P1=0、P2=0。
- 完整回归首跑因旧 `verify-v0-project-entry-workspace.js` 截取函数时漏带新增 owner 计数器而红灯；确认属于测试夹具漂移，校准夹具后最终源码 `npm test` 全绿。该红灯不得被后续绿色抹除。

### 0.2.0 阶段 B 核心服务（2026-08-03）

- 已实现 Main-only `workspace-inventory-service` 与独立 Worker runner：确定性 Markdown inventory、标题索引、正文计数、章节状态、扫描前后项目权威复核和 5 秒硬终止。
- 已实现 `project-home-snapshot-service`：统一 authority vector、最近文件/章节/待审/问题/来源区块、严格 Sources 状态、2 MiB 有界 partial 响应；Graph、Source、Pending generation 在扫描前后必须一致。
- 已实现 pending public projection 与 `workspace-location-service`：公开结果不携带 root/capability/revision，resolve 时重新核对当前项目、inventory、revision、offset 和待审身份；公开列表淘汰不会删除底层 ChangeSet。
- `npm run verify:daily-workspace` 全绿；原 pending store 回归 14/14；多轮独立复审最终 P0=0、P1=0。
- 保留 P2：无 `Intl.Segmenter` 环境的 emoji fallback、inventory 16 MiB 总读取上限的 partial 策略、Home 输入 exact-key/plain-object 加固、Workspace Location TTL/候选流式化及 2 MiB 精确 `+1 byte` fixture。它们不得被误写为已关闭。
- Main handler、IPC/preload 窄桥已接通：完整 Home/Graph/Source/mtime 聚合在同一 5 秒可终止 Worker 内完成；Location 可独立冷启动；Graph entity/issue 与 pending 均由 Main adapter 解析；IPC 返回稳定 public envelope。
- 真实 Electron focused harness 强制启动后 2/2 通过：真实 preload→IPC→Main 首页/位置成功、实际项目切换后的旧 location 拒绝、oversized 项目的 watcher 稳定失败，以及 public payload 无 root/capability 泄漏。
- 真实组合红灯发现并修复：合法 `Graph:Unicode-路径.md` 曾被上下文解析器误判为 URI，导致 inventory 整体失败；inventory 现只复用 Markdown 标题 grammar，并以真实项目相对路径独立生成稳定 `sec_` ID。Worker runner 只公开 allowlist code 与固定文案，不再转发 Worker 原始 message。
- 最终源码后 `npm run verify:daily-workspace`、`npm test`、focused Electron 2/2 全绿；独立复审 P0=0、P1=0。阶段 B 已关闭，但 Renderer 产品界面尚未实现，因此仍不能称为 0.2.0 App 功能可用。
- 保留 P2：两次 38 阶段全量 Electron harness 分别在旧 Changes recovery 后的 CDP evaluate、旧 Markdown Trash 列表等待处红灯；相同源码的 Daily Workspace focused 均通过，暂归类为大型 harness 时序不稳定，后续阶段 E 治理。真实 Worker crash 的 IPC 脱敏由注入测试覆盖，尚未为生产增加 E2E 故障后门。
- 阶段 0 已通过实现、专项/完整回归、真实 Electron 与独立复审；这只表示技术基线完成，不表示 0.2.0 用户功能完成、候选完成或已发布。

### 0.2.0 前置技术卫生

以下历史路线遗漏已在 0.2.0 阶段 0 关闭：

1. **Main → Renderer 反向依赖已归零**：`block-anchor`、`context-selection` 已迁入 `src/shared/`；Main/Renderer 共用同一 UMD 实现。新增解析后的静态依赖门禁、Node/浏览器行为等价测试、Renderer script 与 npm tarball 断言。
2. **旧 Project Plan 已物理移除**：删除 11 个旧 Main/Renderer/测试文件，清除 Changes/E2E/package 残留；Chapter 内部区块规划、普通 Changes 范围预检、Research、Graph Issue 和历史 metrics 兼容保持可用。
3. **Navigation 已统一为 changes-only**：每张建议只签发一个 `changes` capability；依据链接直接使用 Main locator；`needs_sources` 仍回到同一任务，独立 Research 仍从 Sources 单独启动。
4. **Navigation 最大组合边界已闭合**：最大 2000 字/4096-byte goal、4096 evidence enum、最大 Unicode 输出与精确 1 MiB provider request 在同一 fixture 通过；`+1 byte` 在 provider 前以 `NAVIGATION_PROMPT_TOO_LARGE` 拒绝。
5. **复用既有能力**：`⌘⇧F` 保持全文搜索，`⌘P` 只做快速导航；共用 Main 索引，禁止第二套文件扫描。workspace 已能恢复标签、当前文件、光标和滚动，0.2.0 只增加选区、返回路径和安全 schema 迁移。
6. **限定待审 Changes 真相**：当前 pending ChangeSet 是进程内状态。项目首页只展示当前会话可验证的待审项；不得暗示重启后仍持久存在。

### 已分流的历史 P2

- Navigation/AI metrics 仍沿用部分历史 `plan/*` 字段：安排到 `0.3.0` 透明 AI 协作统一迁移；旧持久化事件保持可读。
- 图片 alt/caption 独立编辑与已保留素材清理：0.4.0 当前明确排除，除非生效路线图另行批准；不得从本历史项重开 Image Trash。
- Research 准确率、图片价值样本和 10 名作者内测：属于 `1.0.0` Go/No-Go 证据，不是 0.2.0 功能门禁。
- Developer ID、签名、公证和 Gatekeeper：仅在未来选择独立 App 分发时启动。
- 同 UID 0700 reserve 微窗口及已记录 filesystem residual：属于明确接受的威胁模型残余，不得伪装成未完成 TODO。

## 5. 0.2.0 已批准范围

已批准的产品范围：

- 项目首页：最近工作、确定性项目摘要、当前会话待审 Changes、Graph 问题和已有来源诊断；
- 当前章节大纲：标题层级、当前位置跟随和准确跳转；
- `⌘P` 快速打开：文件、标题、实体、问题和当前会话待审对象；
- 可恢复导航：复用现有 workspace 状态，补选区、返回路径和失效定位降级；
- 自动化优先验收与一次最短作者主观旅程；
- 0.2.0 新增或实质修改代码的健壮性、关键注释、JSDoc/合同和反例测试。

明确不做：AI 任务中心、`@` 引用、统一 Prompt 编译、云/协作、多模型、Graph 重做、AI 语义搜索和大纲拖拽改写。

### 阶段 0 验证证据

- `npm test`：通过。
- `npm run verify`：沙箱内首次在真实 DOM sanitizer 以 Electron `code=null` 退出；相同探针在获批非沙箱 GUI 环境 13/13 通过，随后完整 `npm run verify` 通过。红灯保留为环境分类证据，不以绿色覆盖。
- `WRITCRAFT_E2E_FORCE=1 npm run e2e:electron`：真实 Electron 37/37 通过，含 Navigation → inline Diff、接受/Safe Undo、独立 Research 与零 Renderer 网络。
- 独立复审初次发现 P1=3、P2=1：精确 1 MiB 组合 fixture、依据链接真实点击、文档同步和 npm script 递归检查；均已补齐并定向复跑。最终复审 P0=0、P1=0。

### 阶段 A 合同证据

- 新增 `docs/DAILY-WORKSPACE-V1-CONTRACT.md`，冻结单一 Main 快照、生产 envelope、authority vector、正文/章节确定性统计、区块状态、Workspace Location list/resolve、pending public projection、stableLocator、workspace/v2、returnStack、5 秒降级和 50/300 文件性能口径。
- 只读源码审计确认：现有 tree/read revision、标题解析、Graph/issue、Sources、pending store 与 workspace/v1 可复用；字数、章节状态、pending summary、统一 locator、selection/return path 和 close flush 属于阶段 B–E 的真实实现缺口。
- 独立复审首轮 P0=0、P1=4、P2=2；后续复审继续发现生产 envelope、authority vector、临时 locationId 持久化和任意正文返回位置未闭合。全部在合同中修复；最终复审 P0=0、P1=0，最后一个 outline ID 边界 P2 也已补入冻结合同。
- 阶段 A 只修改合同/状态文档，未制作假数据 UI、未新增产品写入权限、未运行付费调用。

## 6. 候选交接与下一动作

1. 阶段 0 已完成并签收；进入阶段 A 前先核对现有 History、watcher、项目树、原生 helper、capability 与 recovery 实现，禁止重复造扫描器或恢复系统。
2. 按冻结合同分层建立 Main snapshot service/handler、窄 IPC、私有存储、比较、Markdown 选择性恢复和安全删除权威；先闭合 failure/state matrix 与最小可运行 checkpoint，再扩展 UI。
3. 阶段 A 必须重新完成相关专项、`npm test`、`npm run verify`、真实 Electron/Computer Use、独立复审和活动文档/Nowledge Mem 同步；阶段 0 与 0.3.0 证据只作兼容基线。
4. npm 版本、dist-tag、Tag/GitHub Release、远端 push 或 App/ZIP 分发均属于新的外部动作，必须由所有者另行明确授权。

## 7. 本轮文档治理结果

- 旧 Project Plan 合同、Phase A 长规格、0.1.x 完整状态账本、早期 PDCA 和 0.1.1 发布说明已移入 `docs/archive/`。
- `docs/INDEX.md` 成为文档选择入口；`docs/ARCHITECTURE.md` 接替 Phase A 中仍有效的工程边界。
- 0.1.2 作者验收、图片合同、首次使用指南、PRD、正式路线图和 `AGENTS.md` 的过时状态已校准或列入同批校准。
- 0.3.0 候选收口已同步 `docs/ROADMAP.md`、`docs/ROADMAP-0.3.0.md`、PRD、README、阶段 E 独立复审记录和 Nowledge Mem。
- 0.4.0 已获批为 `WRC-0.4.0-R1`；阶段 0 合同/基线冻结已由独立复审以 P0=0、P1=0、P2=4 签收，当前派工入口已切换到阶段 A。旧路线图、冻结合同和历史材料的派工权已在 `docs/INDEX.md` 明确撤销。
- `raw/` 与 `deliverables/` 只作研究/历史输入，不得派发当前任务。

## 8. 续作纪律

- 新会话只先读 `docs/ROADMAP.md`、本文件、`docs/INDEX.md` 指向的相关合同和 `v0/package.json`。
- 归档文档只能用于追溯“为什么”，不能回答“下一步做什么”。
- 不从未勾选的历史 checklist 派工；先确认本文件仍将其列为开放项。
- 红灯不能被绿色重跑抹除；当前状态只保留仍有决策价值的红灯，完整过程在归档账本。
- 关键里程碑同步本文件、相关合同与 Nowledge Mem；真实稿证据只保存内容无关字段。
