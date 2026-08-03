# 笔触 · WritCraft · V0 开发状态与续作入口

> 最后更新：2026-08-03（Asia/Shanghai，0.0CQ · 图片作者验收红灯与候选修复）
> 当前状态：**`writ-craft@0.1.1` 已从 exact candidate `c65981e` 发布到 npm `preview`；registry 时间 `2026-07-29T14:30:16.176Z`，shasum `d370c500666e25cfb373852deafa21b232d2bc18` 与本地候选一致。公网隔离安装/启动/退出为 2/2。annotated tag `v0.1.1` 指向同一提交，GitHub prerelease 已公开：`https://github.com/MaxHou-infinity/WritCraft/releases/tag/v0.1.1`。**
> 发布判断：**0.1.1 Developer Preview 已完成版本、自动化、双架构安装、独立复审、npm 发布、公网安装和 GitHub prerelease。registry 标签保持 `preview: 0.1.1`、`latest: 0.1.0`，因此本次没有把 Preview 冒充稳定版，也没有执行 unpublish、占位发布或上传未签名 App/ZIP。**
> 当前目标版本：**`docs/ROADMAP.md` 的 `RM-1.2 / writ-craft@0.1.2`。真实 GUI 图片旅程已由“未测试”转为明确红灯：生成/解码/渲染通过，但自动插入提示词污染与终态 stale 必须关闭。当前唯一顺序是：图片 P1 修复与受影响复验 → exact candidate 发布复验 → npm `preview` 与 GitHub prerelease。不得创建 `v0.1.2` Tag/Release 或发布 npm，直到红灯关闭。**
> 当前源码证据：**`e8b9588` 只继续作为已签收统一任务基线，不再是发布候选。工作树修复把自动插入固定为 `![章节配图](相对路径)`，不再把 prompt 带入正文；keep 在同窗口/项目/root/navigation 且 generation 只向前时允许结算；delete 在任何正文变化后明确阻止，避免移动已被 Markdown 引用的资产。最终 Image Handler **13/13**、Renderer **8/8**、Metrics **20/20**、完整 `npm test`、批准 GUI `npm run verify` 与强制真实 Electron **37/37** 均通过；E2E 动态证明磁盘正文含中性 alt 且不含 fixture prompt。独立终审 **P0=0/P1=0/P2=2**，可以提交候选并进入仅受影响作者复验，仍不可直接发布。**
> 当前作者验收进度：**此前签字模块仍保持关闭。作者已证明真实图片生成和正文渲染正常；同时保留两项 P1 红灯：自动插入曾把生成提示词写进 Markdown alt，且终端记录出现 `IMAGE_REVIEW_STALE` 三次，导致评分/终态未结算。手工拖入后再删除应被安全阻止，因为该资产可能已被正文引用；修复后的 UI 必须给出明确防断图说明。只复验受影响图片路径，不重复统一任务或其他已签字旅程。**
> 本批红/绿账本：**首轮沙盒 `npm run verify` 在 DOM Sanitizer 启动 Electron 时 `code=null`，同命令获准 GUI 复跑 exit 0，分类为环境红灯。强制 Electron 首轮运行到图片阶段后因旧 prompt-alt 断言而红，修正测试合同；第二轮在未改动的 Navigation late-open 阶段超时，保留为时序 P2；第三轮 37/37 通过。绿灯不覆盖这三条历史红运行。**
> 本批保留 P2：**固定“章节配图”可阻止 prompt 污染，但可访问性描述较弱，后续应提供独立 alt/caption；正文变化后 delete 必须安全阻止并以“保留素材”结束评审，当前流程尚无清理该已保留素材的入口。Nowledge 的“Image Trash 不再扩展”决定继续有效，本批只修已公开路径的发布阻断缺陷，不重开 Trash 功能项目。**
> 0.0AA 历史保留红灯：**首轮真实 Electron 暴露 Inspector 在上下文失效时被清空、旧 5-chip 断言和项目 Chat 等待诊断；完整 test 又暴露 Plan 测试把 generation 函数正文写死。独立复审发现新请求预检窗口可提交不可见旧轮、同项目重开 UI/Main 串话、失败重开提前清会话及两项测试/错误文案缺口，均转为生产边界和回归后关闭。真实 Electron 曾连续两次在旧 Graph 恢复阶段超时；加入只读失败快照后该阶段连续四次通过，未改 Graph 产品逻辑，按重复同源证据关闭 timing P2。另一次 Chat preflight 红灯证明测试在恢复 `edit.md` 后未等待权威 watcher barrier；改为生产 `flushExternalChanges()` 收敛，而未放宽 Chat guard。该里程碑所有红运行保留，最终源码连续两次 34/34；后续 0.0AB 当时推进到 35/35，当前总链只看本文顶部当前里程碑。**
> Graph 历史签字基线：**性能修复前的既有源码曾完整 `npm test`、Electron-enabled `npm run verify`、强制真实 Electron 26/26 exit 0；Graph Filter 15/15、Workbench 14/14、dynamic 5/5、Large 5/5、Watcher 15/15、Network 11/11、Intelligence 17/17，第二轮复审 P0=0/P1=0/P2=2。该数字只保留为历史过程；0.0AB 后来推进到 35/35，当前总链只看顶部当前里程碑。**
> Graph 动态边界：**300 文件/1279 节点 cold-to-interactive、cache/incremental、筛选/内存/布局、AX/键鼠、三类纠错、stale/Issue→Changes、failure live、重启与项目隔离均进入真实 Electron；正文/History/ledger 的零写入门禁通过。**  
> Graph 保留 P2：**200% 仍采用 CDP DeviceMetrics 等价模拟，未调用 Electron `setZoomFactor(2)`；pan/zoom 以 Long Task observer 为性能证据，空数组也会通过，但 transform 的真实变化已有断言。这两项不阻塞签字，后续不得误记为已关闭。**  
> 产品权威规格：`../docs/WRITCRAFT-PRD-V3.md`  
> 产品开发路线图：`../docs/ROADMAP.md`（`RM-1.2`；当前目标产品版本 `0.1.2`）
> 统一写作任务合同：`../docs/UNIFIED-WRITING-TASK-V1-CONTRACT.md`（0.0CO 技术与真实作者旅程均已签收；不得重复）
> 写作导航合同：`../docs/WRITING-NAVIGATION-V1-CONTRACT.md`（已冻结；替代公开 `writcraft.plan/v2`）
> Phase A 工程契约：`../docs/PHASE-A-IMPLEMENTATION.md`
> 真实作者验收契约：`../docs/AUTHOR-ACCEPTANCE-V1-CONTRACT.md`（已冻结；0.0U 不改变真实作者门禁）
> Changes/History 恢复契约：`../docs/CHANGES-HISTORY-RECOVERY-V1-CONTRACT.md`（2026-07-26 已冻结并完成全链签收）
> Chat Conversation 契约：`../docs/CHAT-CONVERSATION-V1-CONTRACT.md`（2026-07-28 0.0AA 已实现并独立签收）
> Diagnostic Export 契约：`../docs/DIAGNOSTIC-EXPORT-V1-CONTRACT.md`（2026-07-26 已实现并完成自动化产品链签收）
> Image Review 契约：`../docs/IMAGE-REVIEW-V1-CONTRACT.md`（2026-07-27 Trash 扩展已签字，待真实付费/作者验收）
> Markdown Trash 契约：`../docs/MARKDOWN-TRASH-V1-CONTRACT.md`（2026-07-28 0.0AB 已实现并独立签收）
> npm Developer Preview 契约：`../docs/NPM-DEVELOPER-PREVIEW-V1-CONTRACT.md`（0.1.1 已公开到 `preview`，公网安装 2/2；`latest` 仍为 0.1.0；0.1.2 已获授权且 npm 身份已恢复，仍被图片作者门禁与候选复验阻止）
> 用户安装与首次使用：`../docs/GETTING-STARTED.md`

## 0.0CN–0.0CO · 统一写作任务流 Main-owned rangeId 修复（已完成并验收）

### 真实红灯证据

1. 作者从 Navigation 建议进入 Research，再返回 Changes，期间需要重复选择来源、判断匹配、再次选择锚点已经确定的正文，并在多个页面间转交同一目标。作者明确反馈已经忘记自己正在处理什么，判断该体验不会让真实用户满意。
2. 一次生成在底层网络等待结束后仍显示“处理中”超过三分钟，没有可靠取消和终态。该红灯说明现有 Renderer busy/finally 并未与 Main/provider deadline 共用同一 attempt authority。
3. 以上证据不得被后续绿灯覆盖。旧 0.0CL 的具名 Research tool-use、安全 handoff 和零写入验证仍是可复用技术资产，但不再代表当前产品旅程合格。
4. 2026-08-02 作者验收-11：`edit.md` 活跃且补充上下文为 0 时，生成按钮仍可点击；Main 在 provider 前返回 `CONTEXT_REQUIRED`，Renderer 却显示通用“AI 没有完成”。本次 14/14 Markdown 与源一致、manifest 后 History=0；这是前端 admission 与恢复文案 P1，不得误记为付费模型失败。

### 已冻结方向

- 每张建议只有一个主要动作“处理这个建议”；正常路径一次点击后，在当前正文编辑区进入可审阅 Diff。
- Main 使用 suggestion 的 canonical evidence 和默认正文目标；普通作者不再进入独立 Research/Changes 页面，不再重复选择目标或人工转交依据。
- 只有严格 `needs_sources` 零修改终态显示“添加来源”，补充后返回同一任务。
- 右栏持续展示当前目标、真实阶段、折叠依据和范围；正文内用红色删除线、绿色新增及非颜色标识审阅，跨文件通过标签/文件树徽标导航。
- 15 秒显示取消，60 秒硬终止；单次最多 1–3 个局部修改且不自动付费重试。取消、超时、失败、迟到与项目切换均零写入并保留可重试任务。
- 继续复用 Main-owned revision、locator、range、ChangeSet、History、冲突检测和 Safe Undo；不得解析自由文本、降低校验或扩大写 capability。

### 当前完成度与下一步

- ✅ 产品/工程合同：`UNIFIED-WRITING-TASK-V1-CONTRACT.md` 已冻结。
- ✅ Main 统一 attempt 编排、50 秒 provider deadline、显式取消和唯一具名 `needs_sources | changes` 结构协议；单次严格限制 1–3 个局部修改，不自动付费重试。
- ✅ Renderer 同任务状态机、单一主动作、同任务来源恢复、15 秒可取消与 60 秒硬终态；保存阶段超时也会阻止迟到 provider 调用。
- ✅ 主编辑器瞬态 inline ChangeSet review：删除为红色删除线、新增为绿色插入，单块审阅移除冗余批量按钮；确认前稳定正文与磁盘保持不变。接受结果绑定 History，Safe Undo 会回传同一导航任务显示“已安全撤销”。
- ✅ 2026-08-01 收口定向证据：Unified service **12/12**、handoff **8/8**、action handler **20/20**、Renderer state **14/14**、dynamic **12/12**、production integration **8/8**、Changes review UX **12/12**；`npm run verify:navigation` 全链、相关 JS 语法和 `git diff --check` 通过。
- ✅ 2026-08-01 E2E 夹具检查点：`electron-ai-provider` 已严格识别 `submit_writing_navigation` 与 `submit_unified_writing_task` 两个具名工具，并用请求内 evidence/range ID 生成确定性局部修改；真实 Electron 脚本由 **36 个历史阶段调整为 37 个现行阶段**，新增“建议一次点击 → 正文内 Diff → 拒绝零写入”与“接受 → History provenance → Safe Undo 精确恢复”。两个变更文件 `node --check` 通过，`npm run verify:navigation` 全链通过，`git diff --check` 通过。
- ⚠️ 红灯保留：首次完整 `npm test` 暴露已退休“自动重试”断言；新增全程 timeout 后，dynamic 测试曾误取已清除的旧 generation timer；integration 曾因跨 VM prototype 使用 `deepStrictEqual` 失败。三者均判定为测试漂移并修正，原始失败不能由复跑绿灯抹除。
- ⚠️ 真实 Electron 红灯及根因：首轮目标标记被更早 Inline 夹具重建正文时遗漏；修正夹具生命周期后，生产边界稳定返回 `PATCH_NEW_TEXT_TOO_LARGE`。后者不是测试漂移：统一工具要求模型复述整个长范围，与 640 字局部输出上限自相矛盾。现改为范围内短 `oldText` 唯一锚点和短 `newText`，路径、revision、offset、唯一性及重叠仍由 Main fail-closed 校验。红运行均保留，未靠扩大 AI 权限或放宽校验掩盖。
- ✅ 最终工作树完整 `npm test` 与批准 GUI `npm run verify` 均 exit 0；强制真实 Electron **37/37** exit 0，新阶段覆盖一次点击→正文内 Diff→拒绝零写入，以及接受→History provenance→Safe Undo 精确恢复。
- ✅ 独立复审保留的首轮红灯：Schema 允许 640 个四字节字符但 Main `oldText` 仅允许 2 KiB；ChangeSet 构造可接受伪造 parsed；成功结果漏传 `fileCount`。第二轮又证明 WeakSet 品牌未绑定请求且可重放。最终改为 512 scalar 闭合上限、模块私有 WeakMap 绑定 exact snapshots/ranges identity 并单次消费、ChangeSet 前复验 exact slice、正确传播 `fileCount`；跨请求同内容、二次重放、512/513 emoji 和 action 返回链均有回归。
- ✅ 第三轮独立只读复审 **P0=0、P1=0、P2=0，可以技术签字**；未沿用任何早于最终修复的旧结论。
- ✅ exact candidate 已提交为 **`1b51595 fix(navigation): bind unified edit authority`**；该提交包含最终生产修复、回归和本批文档，未推送、未发布。
- ✅ 作者确认源再次只读预检为 eligible：20 files / 608,433 bytes / 12 chapters / 4,748 可见中文字符 / 1 source，digest 仍为 **`9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`**。已通过生产复制事务创建新副本 **`/Users/maxhou/Desktop/Max 项目-2026/WritCraft 作者验收/WritCraft-0.1.2-作者验收-10`**，返回 `copyCreated=true / sourceUnchanged=true`；manifest `createdAt=2026-08-01T14:54:22.350Z`。副本继承的 3 条 History 与 23 条 metrics 均早于本次 manifest，不计入新旅程证据。
- ✅ exact candidate `2bb9052` 后已通过同一生产事务创建 fresh **作者验收-11**：`copyCreated=true / sourceUnchanged=true`，源再次为 20 files / 608,433 bytes、digest **`9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`**。新副本为 eligible：21 files / 608,701 bytes / 12 chapters / 4,748 可见中文字符 / 1 source，digest **`02aa6257f7d089b76fd1aeaa1621d029a1fe6db565500c2abf50379d07bd08d1`**；manifest `createdAt=2026-08-01T15:49:19.263Z`。继承的 3 条 History 与 23 条 metrics 均早于该切点，新旅程计数为 0。
- ✅ 当前源码 App 已恢复作者验收-11并正确显示 Navigation，不再复现“项目已打开但导航要求打开项目”的握手红灯。启动只更新了允许持久化的私有 `.writcraft/workspace.json`，因此包含私有状态的全树摘要变化为 `927283fec97af50db44bc4ae5ac5725a693605ba063531197770071a83322869`（608,530 bytes）；源摘要仍未变，源与副本的 **14 个 Markdown 文件逐文件 SHA-256 全部相同**，manifest 后 History 仍为 0。这是会话恢复状态，不得误报为正文写入或候选漂移。
- ✅ 当前修复已完成完整 `npm test`、批准 GUI `npm run verify`、真实 Electron 37/37 与最终独立复审 P0/P1/P2=0。
- ⚠️ 诊断时首次按应用名读取界面，Computer Use 自动拉起了 packaged App，与既有开发版短暂并存并共用 userData；这是助手造成的验收环境污染，不是用户遗留。该 packaged 进程启动在红灯之后，不改变根因/零写入证据；两个进程已全部正常关闭。继续验收前必须只启动一个新候选进程。
- ✅ 新 local exact candidate 已保存为 `f2775cf`，未推送、未发布。
- ✅ 生产复制事务创建 fresh **作者验收-12**：源仍 eligible，20 files / 608,433 bytes，digest `9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`，返回 `copyCreated=true / sourceUnchanged=true`。新副本 eligible：21 files / 608,701 bytes，digest `78f9bbf5fccf6ef9f33621d5869dfcaf90164f38871b01869b512a70f3402d1d`；manifest `createdAt=2026-08-02T02:54:11.703Z`，继承 History=3 / metrics=23，切点后均为 0。
- ✅ 作者已在唯一源码 App 进程和作者验收-12 中确认“生成写作导航”正常；该门禁不再重复测试。此绿灯只覆盖 Navigation 生成，不提前代表统一任务 Diff/写入/撤销链签字。
- 🔴 作者点击建议一“处理这个建议”后，两次均在 Main 结构校验阶段返回稳定 `INVALID_MODEL_OUTPUT`，发生在 ChangeSet/cacheReview 之前；14/14 Markdown 与源一致、manifest 后 History=0。现场没有保留具体拒绝字段；代码复审确认了合同缺陷及高可信原因：工具描述禁止模型返回原文，Schema 却强制 edit 带 `oldText`。完美构造 `oldText` 的 E2E 夹具未覆盖真实模型遵循冲突描述的情况。泛化“调整目标或上下文”文案也是次生 P1。
- ✅ 已实现 Main-owned 证据 `rangeId` 协议：每张建议严格绑定一个同文件 canonical evidence；Main 冻结精确范围、提供各 240 UTF-16 单元以内的相邻只读上下文，并私有恢复原文/path/revision/offset。模型只返回 `rangeId/newText/summary`，且仅选择有限 `editIntent`；Main 将其确定性映射为局部动作。工具 Schema 用互斥分支闭合 changes/needs_sources，重复/未知/重叠/夹带范围、Unicode scalar 截断、复制/重放、超限与迟到结果均 fail-closed；Renderer 单列结构校验零写入恢复说明。
- ✅ 技术验证：专项 `npm run verify:navigation` 全绿（unified service **14/14**、Navigation service 29/29、store 21/21、handoff 5/5、action handler 19/19 等）；完整 `npm test` exit 0，批准 GUI `npm run verify` exit 0。最新源码首次强制真实 Electron 在统一任务阶段红：产品已使用 Main-owned“压缩”动作，E2E 夹具仍断言旧“精简”文案并抛出 `REQUEST_FAILED`；只修正夹具漂移后同一真实 Electron 全链 **37/37**，包含统一任务拒绝零写入、接受写入和 Safe Undo。不得用绿灯抹去该首轮红灯。
- ✅ 独立复审在第二轮达到 **P0=0、P1=0**；其两个非阻塞 P2 已继续修复：selected-range builder 现在显式拒绝 UTF-16 surrogate pair 中间边界并有 14/14 回归，合同也把“唯一确定根因”改为“已确认合同缺陷及高可信原因”。最终只读复审为 **P0=0、P1=0、P2=0**。
- ✅ MiniMax 真实结构 canary 已由本次作者操作通过：同一点击返回合法 `oneOf` changes 分支并显示正文内 Diff；没有格式重试或隐藏付费调用。官方文档未明确枚举 `oneOf`/`const` 的历史外部门禁据此关闭。
- ✅ exact candidate 已提交为 **`e8b9588 fix(navigation): bind one local edit anchor`**，未推送、未发布。
- ✅ 生产复制事务创建 fresh **作者验收-13**：源仍 eligible，20 files / 608,433 bytes，digest `9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`，返回 `copyCreated=true / sourceUnchanged=true`。manifest cutoff `2026-08-02T06:33:47.698Z`；继承 History=3 / metrics=23，切点后均为 0。
- ✅ 作者在最新源码 App 中看到正确正文内 Diff，接受后生成 exact History；Safe Undo 将该 History 置为 `undone` 并精确恢复原稿。作者验收-12 同时保留此前两次零写入红灯和本次有界绿灯，验收-13 保持未使用，不再重复测试。
- ✅ 2026-08-03 发布审计：registry 仍为 `preview: 0.1.1`、`latest: 0.1.0`，0.1.2 不存在；GitHub 仓库为公开且尚无 `v0.1.2` Release。生产依赖 audit 为 0 vulnerabilities，npm Preview **10/10**、隔离 installed **2/2**、packaged release **7/7**。当前 dry-run tarball 为 **135 files / 667,444 bytes packed / 3,119,465 bytes unpacked / shasum `6fcffabcdf2253df1407887a55ac9a82d0c96e25`**。这些是工作树候选准备证据；最终文档提交后仍须重跑精确候选门禁。
- ✅ npm 身份恢复：首次 `npm whoami` 为 E401；经官方浏览器登录后只读复核为 `houxyue`，registry 仍无 0.1.2。没有因此跳过图片作者门禁、发布包或创建 GitHub Release。

### 2026-08-01 recent-project 握手 P1（已关闭，exact candidate `2bb9052`）

- **现场红灯**：作者验收-10 已由编辑器正常恢复，但 Navigation 显示“打开写作项目后使用导航”。根因是 `workspace.js` 的 recent-project 自动恢复可能在 `assistant-workspace.js` 注册 `writcraft:project-entered` 监听器之前完成。
- **最终实现**：`workspace.js` 增加 `projectReady`、entry generation 与 single-flight request owner；open/create/recent 共用 owner。`loadEditContext`、Inline/Changes reconciliation、孤儿恢复和旧草稿迁移在每个内部 await 后、每次 state/UI/bridge mutation 前复验 exact generation + project instance；stale preview 只释放自己取得的 capability。Assistant 在 entering/failed 时清旧 Navigation，并在监听注册后同步已 ready 项目；`canUseAI` 与 Dock 入口要求 ready。
- **最终动态证据**：Project Entry **7/7** 真实执行生产 `loadEditContext`、legacy/orphan helper，覆盖 A `getContext` 晚于 B、A legacy/orphan confirm 晚于 B、foreign request finish 与 single-flight；Inline workspace **7/7** 又覆盖 production reconciliation 的 deferred A→B。Renderer integration **10/10**、Changes review **6/6**、Navigation 全链通过。
- **独立复审红灯**：第二轮仍为 **P1=1、P2=1，不可签字**。`loadEditContext()`、`maybeOfferOrphanRecovery()`、`maybeOfferLegacyDraft()` 在 helper 内部 await 后会直接写全局 state/UI 或执行迁移副作用；旧 A 即使最终被外层 generation 拒绝，也可能先污染 B。新测试把这些 helper mock 为无副作用，未覆盖真实交错。另有新尝试在 preflight 前取消旧 owner、随后 preflight 失败时可能遗留半进入状态的交接风险。
- **验证红灯保留**：产品 P1 关闭后的首次完整 `npm test` 因两项旧源码字符串断言仍要求无参数 recovery 调用而红；修正为 owner-aware 精确顺序并补 deferred 覆盖后，完整 `npm test` exit 0。不得用最终绿灯抹去该测试漂移红灯。
- **最终门禁**：`npm run verify:navigation`、完整 `npm test`、批准 GUI `npm run verify` exit 0；强制真实 Electron **37/37**，包含统一任务 Diff/接受/Safe Undo、退出重启与 recent-project 恢复。第四轮独立只读复审 **P0=0/P1=0/P2=0，签字 YES**。

**当前纵切结论**：统一写作任务流已完成真实作者签收，不再派发作者验收-13或额外 provider canary。所有者已于 2026-08-03 授权后续 npm/GitHub 发布，npm 身份也已恢复；下一动作只由图片作者验收、精确候选复验及公网发布证明决定，授权不得替代这些门禁。

**旧暂停点仍失效**：不得从 `1b51595` 或作者验收-10续跑。此前已签字模块仍不重测，不得回到旧 Research→Changes 人工转交；图片作者门禁与精确候选复验关闭前不得发布 0.1.2。

## 0. 续作口令

Chat 的三级 scope/context、Main-owned 多轮连续性、Onboarding v2、Research→Changes 技术底座与 Inline Rewrite v2 已经完成技术签字。项目卡、Inline、Chapter、空项目结构、Navigation 建议价值和统一写作任务均已真实完成。旧 Plan 在九次真实失败后停止；当前只关闭 `image-01` 作者评分/终态与发布门禁，不再执行旧 canary、Research 人工判断链或已签字旅程，不分发现有 `release/` 产物。

1. 先读 `../docs/ROADMAP.md` 的当前目标，再读本文、`package.json`、对应合同、当前源码文件与 `git log -1 --stat`；本地 Git 历史从 2026-07-26 V0 基线开始，不得据此臆测更早的开发过程。
2. **Diagnostic Export v1、Research Accuracy v1、committed-warning、Graph 三项韧性缺口、Changes/History durable recovery、Image Review v1 与 Image Trash 本地链均已完整签收，不再重开这些协议。**
3. 0.0AB 已完成普通 Markdown 项目回收区；0.0AC 的 npm Preview/Coding Plan 图片改造已在提交 `71571b8` 与权威 Nowledge 记忆中收口，0.1.1 的 npm/GitHub 发布链也已关闭。恢复顺序必须是：核对 Git HEAD 与顶部证据 → 只推进真实图片作者终态、精确候选复验、npm/GitHub 0.1.2 发布证明。不得重开统一任务、回收区、Chat、Prompt 或 watcher 安全链。
4. 不重写已经签字的 Onboarding v2 service、capability store、batch、Main/preload 与 Renderer 契约；Main 动态 admission、single-flight 和 Renderer 生命周期 authority 清理均已关闭。
5. 每批合入后重跑定向测试；阶段完成时再运行完整 `npm test`、`npm run verify` 与 `WRITCRAFT_E2E_FORCE=1 npm run e2e:electron`，保存当次证据。
6. 真实 API 只使用用户显式配置的 Key；记录延迟、限流、超时、故障和费用，不记录 Key、Prompt、模型原文或正文。Key 前缀只表示凭据/计费类型，不能代替官方能力与现场门禁。首发按 npm Developer Preview 合同执行；独立 App 发布才需要 Developer ID、公证与 Gatekeeper。

### 0.0CL 2026-08-01 · Research 自由文本 JSON 迁移为具名结构化工具（历史；默认旅程已被统一任务取代，无需复验）

- **真实红灯**：作者从 Navigation 正确进入 Research、勾选 1 个来源并运行后，界面显示“AI 研究结果不是严格 JSON”。导航问题、发现和 canonical 原文依据已正确到达；失败发生在真实 provider 返回后的初始 Research 解析，项目文件零写入。
- **根因**：`research-service` 仍要求模型在普通 text block 中自行输出 JSON。真实 MiniMax 可以附加解释或 Markdown 围栏；继续加重提示词只能降低概率，不能形成协议保证，也会重复消耗作者时间与额度。
- **生产修复**：新增唯一 `submit_research_cards` tool choice。动态 Schema 只允许本次显式选择的 source ID，并冻结卡片字段、1–20 数量及文本长度；Main 要求 raw tool-use 总数恰好为 1，再执行原有逐字 quote/UTF-16 locator/revision/来源末端重验。普通文本 JSON 不再有兼容降级或自动修补。
- **验证**：Research Main/集成/事务/Watcher **12+12+15+12+10+4**，Renderer **17+13**；`npm test`、批准 GUI `npm run verify` exit 0。真实 Electron：夹具协议迁移后一次 28 阶段 CDP timing 红灯，原样复跑 **36/36**；P2 timing 保留。下一动作仅为最新源码下再次点击“研究所选来源”，不重新生成 Navigation。

### 0.0CK 2026-08-01 · “补充来源”过早失效与卡片动作视觉修复（已完成）

- **作者现场**：在建议 2 已成功生成待审修改后点击“补充来源”，界面显示“建议已过期”，并错误附带通用“AI 没有完成整理”文案；两个动作按钮尺寸、填充和排版过重，不像写作卡片中的次级工具。
- **根因**：Research handoff 在 Main 返回成功时即永久消费 action；若 Renderer 打开 Sources 路由失败，UI 虽允许重试，Main 已只会返回 `ACTION_NOT_FOUND`。并发 Research 还会把第一条 lease 当重放主动终止。通用错误映射没有区分来源路由、待审 Changes 与模型生成失败。
- **生产修复**：Research 是只读 handoff，现保留为受 TTL、项目和依赖约束的 repeatable capability；串行路由失败可重试，并发第二次返回 `ACTION_BUSY` 且不能 abort/消费第一条 lease，Changes actionId 仍独立单次消费。`RESEARCH_ROUTE_FAILED` 和 Changes pending 使用各自可执行文案，不再冒充 AI 生成失败或承诺永久有效。
- **视觉修复**：卡片动作区改为可换行的紧凑编辑工具条，按钮高度 28px、11px 字号、4×9px 内边距和胶囊轮廓；主按钮改为 `#476b64`，白字对比度由测试锁定 ≥4.5:1；完成/失效态保持安静的非透明状态标签。
- **当前验证**：Store **20/20**、Action handler **16/16**、Renderer state **14/14**、production Renderer integration **6/6**、public surface **5/5**，`npm run verify:navigation`、完整 `npm test` 与批准 GUI `npm run verify` 均 exit 0；最终独立复审 **P0=0/P1=0/P2=0**。跨层回归真实穿过 production `assistant-workspace`：Sources 首次路由失败→同一 Research actionId 第二次成功→Changes sibling 仍成功。最新 App 重启后只重跑受影响的“补充来源”最短链，不重做帮助度或 Navigation→Changes。

### 0.0CJ 2026-08-01 · Navigation 刷新丢进度与动作可发现性真实红灯（进行中）

- **作者现场**：Navigation→Changes 签字后，作者刷新项目页面并重新打开项目，已生成的 Navigation 结果和动作进度丢失，被迫再次付费生成。新结果的建议 3 在作者截图中显示“生成修改建议”，没有可见“补充来源”；稍后同一运行界面又迟到变成“补充来源”。作者没有漏看按钮。
- **P1 根因边界**：Navigation 结果/action capability 仅存在 Renderer/Main 内存；Main 在主框架导航、Renderer 崩溃/销毁和项目实例切换时主动失效，项目 workspace 只保存 tabs/activePath/cursor/scroll。另一个协议缺口是模型输出单一 `action=open|research|changes`，让模型决定卡片唯一 CTA；Research 入口因此不确定，并可能在旧/新结果所有权切换中显示不同动作。
- **当前阻断与修复方向**：暂停 Research 人工点击和再次付费生成。Main 必须在刷新后从仍可信的同进程权威记录重验项目/root/generation/evidence revisions，并为新页面重新签发 action；Renderer 不得持久化或回传模型正文作为 authority。每条建议的本地打开、补充来源和生成修改建议应由产品能力决定并明确展示，模型不得控制唯一入口。刷新/项目重开、旧 finally、新旧 CTA、stale revision、跨项目和无第三次生成均需动态验证后再恢复作者验收。
- **生产修复**：Main store 现在区分 `parkProject` 与硬 `invalidateProject`。Renderer 刷新或同 App 重开只停放 record，同时 abort 运行中 lease 并撤销所有旧 action ID；正文/edit.md 变更仍硬删除。新 resume IPC 只接受 project instance ID，经过 watcher barrier 后重验 edit、全部 source revisions、每个 evidence quote/heading/locator，以及与生成共用的 canonical 项目树规则，再绑定当前 generation/Renderer epoch 并签发新 Research/Changes capability；不调用 provider。Renderer 的迟到 resume 不能覆盖新生成或项目 B，无效恢复结果也会退出 busy 并显示可重试失败。
- **交互修复**：原文依据链接始终负责本地打开；每张建议固定同时展示“补充来源”和“生成修改建议”。模型历史 `action` 字段仅保留内部兼容，不再控制公开 CTA。两个 capability 独立消费，不能互相串用。
- **当前验证**：Navigation 全专项全绿：Renderer state **14/14**、dynamic **9/9**、integration **5/5**、service **29/29**、store **19/19**、handler **14/14**、handoff **8/8**、action handler **16/16**、Main wiring **4/4**、zero-write **2/2**，结构确认全链亦全绿。最终源码完整 `npm test` 与批准 GUI `npm run verify` 均 exit 0。首轮复审 P0=0/P1=2/P2=2；修复 invalid-restore busy 泄漏、4097–5000 节点范围不闭合、树规则漂移和 capability remint 非原子并加入对抗测试后，最终独立复审 **P0=0/P1=0/P2=0**。强制真实 Electron 三次在三个不同既有阶段超时，第三次已越过 Navigation 公共入口；按整链时序 P2 保留。只待最短作者复验后关闭 0.0CJ。

### 0.0CI 2026-08-01 · Navigation→Changes 真实单项越界与范围协议收口

- **最新作者复验｜完整关闭**：提交 `da5e8d6` 启动后，作者用原目标重建 Navigation authority；真实 MiniMax 成功生成右侧当前章节 **3 项修改、待决定**。预览阶段目标 SHA 保持 `1bdb3a5c…`、recovery=0、无新增 History。作者随后接受全部 3 项并提交，只有目标章节变为 `d83ec04a…`，History 新增一条 `writcraft.writing-navigation-changes/v1`、`applied`、单文件记录；`edit.md` 和其余公开文件不变。作者执行 Safe Undo 后，同一记录变为 `undone`，目标精确恢复 `1bdb3a5c…`，recovery=0，副本全部公开文件再次与授权源逐字节一致。Navigation→Changes 的真实生成、零写入预览、人工决定、落盘、History 与撤销闭环正式关闭，不再重复。
- **第二次真实红灯**：作者在第九副本再次点击“生成修改建议”，Main 稳定码为 `PATCH_NEW_TEXT_TOO_LARGE`，不是旧的总输出超量。模型已返回唯一可解析工具调用，但至少一个 `newText` 超过 256 Unicode code points；系统未创建 Diff、待审 capability、History 或项目写入。
- **根因与修复**：`targetId + oldText` 仍让模型决定原文锚点和改写粒度。现由 Main 从冻结目标快照建立 revision-bound、request-local 的 `range_1…range_96` 章节范围；模型只能提交 `rangeId/newText/summary`，路径、revision、原文和偏移均由 Main 恢复并重验。每次最多 8 项、单项 640 字、合计 1024 字、summary 40 字，完整工具参数最多 7 KiB，专用输出预算 8192 tokens。
- **一次内部收敛**：首轮仅对严格列举的结构/容量错误（含 `INVALID_TOOL_USE`）自动纠正一次，且不回显被拒内容；第二次仍失败即终止，绝不第三次付费调用。第二次调用前后重新验证 action lease、项目、Navigation evidence 和所有文件 revision，失败不缓存审阅。
- **验证**：localized **14/14**、proposal **12/12**、action **17/17**、handoff **6/6**、Renderer **12/12**；`npm run verify:navigation`、完整 `npm test`、批准 GUI `npm run verify` 均 exit 0。沙箱 verify 的 Electron `code=null` 由同命令批准 GUI exit 0 归类为环境限制。独立终审 **P0=0/P1=0**。强制真实 Electron 首跑在与本改动无关的“普通 Markdown 回收区可见列表”阶段超时，前五阶段通过；该红灯保留为时序 P2，不能用重跑抹除。
- **开放门禁与 P2**：真实 MiniMax Diff 仍需作者在最新源码沿最短 Changes 链复验。非阻断 P2：范围正文当前使用伪 XML 分隔、单个章节区块超过 32 KiB 时 fail-closed、一次内部纠正最坏约 180 秒且缺少第二阶段专属进度文案。强制真实 Electron 第二次复跑越过回收区后又在 Graph CDP 鼠标事件超时；两个不同阶段的红灯共同表明整链时序不稳定，均保留且不算 Changes 产品回归已通过。没有发布 npm、移动 dist-tag、推送 GitHub Release 或分发 App/ZIP。

### 0.0CH 2026-07-31 · Navigation→Changes 超量输出真实红灯与结构化修复

- **真实作者红灯**：作者复用第九副本当前 Navigation 建议点击“生成修改建议”。请求真实到达 provider，但 Main 以稳定码 `MODEL_OUTPUT_TOO_LARGE` 拒绝；Renderer 只显示了通用“调整目标或上下文”。没有 Diff 或待审 Changes，manifest 后 History **0**、recovery **0**，公开文件与授权源逐文件一致。该失败不是作者操作错误，也不是目标或上下文缺失。
- **根因**：handoff 虽要求局部 JSON，却仍使用自由文本和 8192 tokens；模型可以返回超过 localized parser 24 KiB 的结果。单纯提高上限会破坏局部修改边界，降低 token 又只会把同一问题变成截断。通用错误文案还把协议容量失败错误归因给作者。
- **生产修复**：该 handoff 现在必须且只能调用 `submit_localized_edits`。Main 按目标快照顺序生成 `target_1…target_8`，在 Prompt 与动态 schema 中使用同一映射；模型看不到可伪造的路径 authority，Main 在返回后恢复 canonical path。单次最多 8 个局部替换，old/new/summary 分别最多 128/256/40 Unicode code points；old/new 允许 TAB/LF/CR 以支持跨段结构调整，其他 C0、孤立 surrogate、未知 target、额外字段、多 tool block、非 `tool_use` 或 `max_tokens` 全部 fail-closed。完整 after 仍只由 Main 在权威 before 上构造。
- **容量与零写入证明**：8 个全 emoji 最大合法 tool input 实测 **14,083 bytes < 24,576 bytes**；每个字段 `+1`、非法 Unicode 与 action 层超量均有红灯测试。超量失败断言 `cacheCalls=0`，同一 action 下一次合法调用可成功，证明 retryable settlement 没有残留审阅。双目标反序测试证明 `target_2` 恢复为第二个真实文件，legacy 普通 Project Changes 仍走原协议并 **12/12** 通过。
- **验证与边界**：`npm run verify:navigation` 全绿，action handler **12/12**；完整 `npm test`、非沙箱 `npm run verify` exit 0，强制真实 Electron **36/36**，`node --check` 与 `git diff --check` 通过。独立复审 **P0=0/P1=0**。自动化只证明协议与 App 链可运行；新的 named tool 尚未完成真实 MiniMax Diff。由于 action ID 是 Main 进程内存凭证，重启后必须用原目标最短重建一次 Navigation authority，然后只复验 Changes handoff。

### 0.0CG 2026-07-31 · 已有稿件 Navigation 生成与原文定位真实作者验收

- **作者操作与可见终态**：作者在第九隔离副本输入真实简化目标并完成生成。可见界面返回 **3 条**建议，每条均展示 Main 恢复的原文依据；作者通过依据链接打开对应章节，导航页、建议卡和章节编辑器同时保留。自动化没有代替作者输入、生成或点击。
- **内容无关运行证据**：manifest 后记录两条 `plan/generated`（metrics v1 的历史 action 名），耗时 **18,314 ms / 13,562 ms**，均为 before/after 0；没有 `failed`。这证明 `d28c440` 的 request-local evidenceRef 协议在真实 MiniMax 调用中越过了第八副本连续失败的 `INVALID_MODEL_EVIDENCE` 边界。两次成功均保留，但后续不再要求重复生成。
- **零写入与隔离**：post-manifest History **0**、recovery **0**；验收副本除 `.writcraft` 私有状态外，与授权源逐文件一致。授权源仍 eligible：20 files / 608,433 bytes、12 chapters、4,748 可见中文字符、1 source，digest **`9d089886…`**。打开章节是本地定位，不产生正文或 History 写入。
- **作者价值判断与当时下一步（已被 0.0CO 关闭）**：作者已明确判断当前 3 条建议“有帮助”。Navigation 的生成、canonical evidence、定位和帮助度关闭且不再重复。当时计划分别验收 Changes/Research；后续真实反馈否定该公开多步旅程，统一任务现已签收，不再续作或复验。

### 0.0CF 2026-07-31 · 已有稿件导航 evidenceRef 协议修复

- **真实红灯**：第八隔离副本中，作者以当前正文与 1/8 Context 连续两次生成写作导航。请求均真实到达 provider，约 **19,010 ms** 与 **17,102 ms** 后由 Main 以稳定码 `INVALID_MODEL_EVIDENCE` 拒绝；公开 Markdown 与验收源字节不变、recovery=0。失败不是 NO_KEY、网络未发出或作者目标为空。
- **根因**：旧工具 input 要模型重新抄写 `relativePath + sectionHeading + quote`，Main 再要求完整标题层级和引文逐字、同区块且唯一。Schema 只能约束字符串形态，不能保证模型复制正文时不改标点、空格或层级；连续真实失败证明继续强化提示词会重复消耗作者额度。
- **生产修复**：Main 用每请求 CSPRNG nonce，对本次已读、revision-bound 的非代码正文区块建立最多 4096 项的临时 `evidenceRef` catalog，并把完整不可预测 ID 冻结进动态 tool enum；正文中的类标记不能进入 enum。模型 suggestion 只返回 schema/runtime 均声明不重复的 1–3 个 `evidenceRefs`；Main 从 catalog 恢复 path、heading、quote、locator 与 revision。未知、重复、跨请求或伪造引用继续 fail-closed，模型仍无写 capability，Renderer 不生成引用或原文 authority。
- **用户反馈与诊断**：极少数后续引用核验失败不再只显示“调整目标或上下文”，而明确说明“原文依据没有通过核对”，同时确认本次未修改项目文件；provider/tool/protocol 返回失败会向 Main 诊断环记录固定枚举码，项目漂移时不误记旧失败。两条链均不暴露 JSON、Schema、路径、Prompt、quote、正文或远端错误正文。
- **验证与边界**：`npm run verify:navigation` 为 service **29/29**、store **16/16**、provider adapter **1/1**、handler **12/12**、handoff **6/6**、action handler **11/11**、Main wiring **4/4**、zero-write **2/2**，结构全链亦全绿；稳定源码完整 `npm test`、非沙箱 `npm run verify` 均 exit 0，强制真实 Electron **36/36**，`node --check` 与 `git diff --check` 通过。一次完整测试在源码仍继续变化时被主动以 exit 130 终止，不计作产品红灯；以上结果均来自冻结后的同一源码。独立终审 **P0=0/P1=0/P2=2，可进入新副本作者验收**。
- **保留 P2**：① 生产已有 1 MiB 完整 provider request 门禁和 4097 候选 fail-closed 测试，但尚缺一个同时填满真实 evidence markers 与动态 enum 的“最大合法 Navigation 请求”精确字节边界 fixture；② 失败码已进入内容无关 Diagnostic Export/控制台环，但私有 metrics 仍沿用历史 `plan/failed/duration` 维度，尚未迁移为 Navigation 专用 action/failureClass。这两项不放宽 authority，也不阻断第九副本单次验收；后续必须单独关闭，不能写成已完成。没有发布 npm、移动 dist-tag、推送 GitHub Release 或分发 App/ZIP。
- **候选与第九副本**：生产修复、测试和首轮文档提交为 **`d28c440`**。随后生产 author-copy 事务创建 `WritCraft-0.1.2-作者验收-9`，返回 `copyCreated=true / sourceUnchanged=true`；源仍为 20 files / 608,433 bytes、digest `9d089886…`，副本含私有 manifest 后为 21 files / 608,701 bytes、digest `db5487b4…`，仍满足 12 chapters / 4,748 可见中文字符 / 1 source。该副本的生成与原文定位已由 0.0CG 关闭；后续不得从本段旧动作派发重复生成。

### 0.0CE 2026-07-31 · 空项目结构规划真实作者验收

- **候选与作者操作**：旅程绑定生产提交 **`2f9f714`**。作者在新的独立空项目中完成连续输入目标、比较并编辑结构方案、查看创建预览、明确确认创建和进入写作导航；自动化没有代替作者选择或点击。
- **内容无关磁盘证据**：确认后公开文件精确为 `edit.md` 与 `chapters/01.md` 至 `chapters/06.md`，正文文件数 6，全部位于约定章节路径；`.writcraft/recovery` 条目为 0，History 不存在。核验没有读取、打印或保存章节标题、写作目的、Prompt 或正文。
- **签字范围**：证明 0.0CD 的连续输入、两阶段可发现性、确认后骨架创建、无恢复残留和“进入写作导航”作者旅程可用；结构规划真实作者门禁关闭，不再重复付费生成或人工操作。它不替代已有稿件导航、Research、image-01、Graph/recovery 或最终 exact-candidate 发布复审。
- **下一动作**：从作者确认的验收源创建新的合格隔离副本，只验收已有稿件导航的 Context、建议帮助度、open、Research 和 Changes；原始项目继续只读证明未变。没有发布 npm、移动 dist-tag、推送 GitHub Release 或分发 App/ZIP。

### 0.0CD 2026-07-31 · 结构规划连续输入与创建动作可发现性

- **真实作者 P1｜输入失焦**：结构规划顶部目标与章节标题/写作目的共用 `dispatch → render → host.replaceChildren()`。每个 `input` 都替换当前控件，所以作者每输入一个字符就失去焦点；旧动态测试每个字段只触发一次，未验证 DOM identity、焦点、光标或中文 composition。
- **生产修复**：文本编辑改为仍经 reducer 和 `onStateChange`、但不重建 DOM 的窄更新路径；本地同步生成/预览按钮禁用态并隐藏已清除错误。连续输入保持同一节点、焦点、selection 和 IME，不改变项目切换、epoch、异步 finally 或 Main authority。
- **真实作者 P1｜动作不可发现**：原能力并未缺失，但第一屏只显示“预览章节骨架”，最终创建按钮藏在下一状态。现在明确展示“预览 → 确认 → 创建”两步说明；第一步 `查看创建预览` 只取得 capability 和精确预览，第二步 `确认创建章节骨架` 才写文件，确认前零写入合同不变。
- **测试补洞**：Renderer dynamic 新增目标、标题、写作目的的连续输入、同一 DOM 节点、activeElement、selection 和 `isComposing` 证明，专项由 7/7 更新为 **8/8**。`npm run verify:navigation` 全绿；完整 `npm test`、批准 GUI `npm run verify` exit 0；真实 Electron **36/36**。独立终审 **P0=0/P1=0/P2=0**。
- **验收与发布边界**：本批改变了生产 Renderer，先前未完成的空项目人工操作不能作为候选签字；必须从当前仍只有 `edit.md` 的空项目重新走一次受影响旅程。没有发布 npm、移动 dist-tag、推送 GitHub Release 或分发 App/ZIP。

### 0.0CC 2026-07-31 · Writing Navigation 公共纵切与真实 Electron

- **公共产品面**：右栏旧“计划”已替换为“导航”，Main/preload 不再注册旧 Plan IPC；历史 Plan 纯 Main 测试只保留在 `verify:plan:historical`，不能作为现行功能派发。
- **双模式 Renderer**：空项目展示 2–3 个可比较方案，作者可独立修改标题/写作目的、预览精确文件字节并确认；提交成功先固定权威终态，再可选刷新树，并提供“进入写作导航”。已有稿件显示本次读取 X/Y、原文证据、时机、建议动作与预期结果。
- **真实动作与恢复**：生成前保存，取消绑定 opaque attempt 并同步释放 lease；当前文件、项目与 Renderer epoch 漂移废弃旧结果。open 可重复定位，Research 只预填问题/证据且不自动运行，Changes 只接收 Main review；NO_KEY、REVIEW_IN_PROGRESS、UNKNOWN/COMMITTED 恢复都有可执行入口。
- **红灯与修正**：完整 Electron 首次在旧 Plan DOM 注入处失败，第二次 36 个产品阶段全过但固定计数仍为 37；两次均归类为旧 E2E 测试漂移，替换现行 Navigation 场景并修正固定阶段后最终 **36/36**。沙箱 `verify` 的 Electron `SIGABRT` 由相同命令在批准 GUI 环境 exit 0 证明为环境限制。
- **验证与复审**：`npm test`、批准 GUI `npm run verify` exit 0；真实 Electron **36/36**、Persistent Main/IPC **3/3**，Navigation 与 Structure 专项全绿，`git diff --check` 通过。独立复审 **P0=0/P1=0**。保留 P2：Navigation→Sources 的旧 Research 迟到隔离已有实现和静态断言，仍可补 deferred 动态竞态；旧 `changes-view.js` 内部 Plan 分支及不可达的历史 Electron 场景尚未物理删除，但已无 Main/preload/tab 可达路径，也不进入现行 stage 计数。
- **发布边界**：尚未进行新的真实作者双旅程，也未收集导航帮助度；没有发布 npm、移动 dist-tag、推送 GitHub Release 或分发 App/ZIP。

### 0.0CB 2026-07-31 · 结构确认与章节骨架三态事务

- **确认前只预览**：新增 `writing-structure-service` 与一次性 `wsc_` capability。作者可以在 AI 方案上修改 1–8 个章节标题和写作目的；Main 用同一 raw validator 重验并生成精确 `chapters/01.md` 至 `08.md` 字节。Renderer 不能提交 revision、root、文件内容或自称可信的空项目状态。
- **三态提交**：新增 durable marker/receipt、独立 universal `writing-structure-helper` 与 `writing-structure-transaction-service`。stage 文件写入、验证、fsync、清理和 no-clobber 发布均经 trusted root fd 的 descriptor-relative helper；precommit 失败只有在 stage 与 controls 精确清理并 fsync 后才返回 `UNCOMMITTED`，发布响应丢失则从磁盘重建 `COMMITTED` 或保持 `UNKNOWN`，绝不诱导重复确认。
- **Main 与共享写锁**：prepare 前 watcher full settle，confirm 只接收 capability ID，并在最终 publish 前同步重验 project instance、generation、epoch、`edit.md` revision、空正文、空树摘要和 `chapters` 不存在。结构 marker 已加入所有其他写路径的共享 guard。提交后依次安装 committed file state、generation 和权威树；任一步失败都保留同一 recovery lease，三步完整后才自动 acknowledge。
- **独立复审推动的修复**：首轮虽然 focused 全绿，复审仍发现 stage 绝对路径 I/O、检查后按路径删除、receipt 元数据不足、authoritative refresh 失败仍 ack、恢复目录非私有五项 P1。修复后 stage→外部 symlink 证明外部零写入，迟到替换证明不误删，marker/receipt 强制 regular/euid/0600/nlink=1，`.writcraft` 拒绝 group/world writable，`recovery` 强制当前 euid/0700；最终复审 **P0=0/P1=0/P2=3**。
- **保留 P2**：macOS 没有按已打开目录 fd 原子绑定 source identity 的 rename 原语，V0 明确不承诺抵御主动同 UID 在最终检查与 rename 间替换；controls 部分清理失败会安全保持锁定但可能需要人工恢复；极端 64 个长期未 ack operation 的内存进度淘汰策略可继续改善。三者均不得在后续文档中写成已关闭。
- **验证与发布边界**：Structure **73/73**、macOS package **8/8**、npm Preview **10/10**、release **7/7**；四个 helper 的源码、签名 universal binary、App 与标准 unzip 摘要链重新建立。未发布 npm、未移动 dist-tag、未创建 GitHub Release。本批仍没有 Renderer 或真实 Electron/作者证据，下一步只接双模式 UI 并移除旧 Plan 公开入口。

### 0.0CA 2026-07-31 · 写作导航 Main 动作交接

- **动作不再停在卡片**：新增 `writing-navigation-handoff-service` 与 `writing-navigation-action-handler`。`open` 每次重验 exact revision/locator 后只返回本地定位；`research` 返回携带 canonical evidence 的研究页 handoff；`changes` 由 Main 从建议证据确定可写目标与只读上下文，重新读取 `edit.md`/正文后生成普通待审 ChangeSet。
- **待审保护**：`pending-changeset-store` 新增 root-scoped admission。动作开始前或模型返回后只要已有待审 Changes，均返回 `REVIEW_IN_PROGRESS`，不替换、不丢弃、不创建第二份审阅；原建议保留，作者处理现有审阅后可以重试。
- **取消与重试语义**：Changes handoff 有 90 秒 deadline，取消信号穿透至最内层 provider。超时、显式取消、provider/格式失败只结束当前 attempt，不消费仍有效 action；成功、stale 或 replay 才终止单次 Research/Changes action。
- **旧回调隔离**：Renderer 后续必须为每次执行创建 `wno_` opaque attempt ID。Main/store 同时绑定 owner、project、root、mutation generation、navigation epoch、action 与 attempt；迟到的 A cancel 在 B 已开始时返回 `ATTEMPT_NOT_ACTIVE`，不会 abort B。取消 IPC 只接收 project instance、actionId、attemptId，不接收正文、revision 或 root。
- **验证**：`npm run verify:navigation` **73/73**、Pending Changes **13/13**、Network boundary **15/15**；changed JS `node --check` 与 `git diff --check` 通过。独立复审先后发现“失败错误消费 action”“缺用户取消”“A cancel 误伤 B”三项 P1，修复后终审 **P0=0/P1=0**。
- **未完成**：本批仍是 Main/preload 与 Node 动态证据；真实 Electron action IPC、Renderer attempt/busy/finally、Research 页消费、Changes 视图接管均留到 Renderer 检查点。结构 capability 与骨架三态事务尚未开始，当前仍不是用户可用功能或发布候选。

### 0.0BZ 2026-07-31 · 写作导航只读 Main/IPC 基础

- **实现边界**：新增 `writing-navigation-service/store/provider-adapter/handler`。空项目只返回 2–3 个结构元数据方案；已有稿件只返回 1–3 个带 canonical evidence locator 的导航建议。Renderer 只可提交模式、目标与路径标识，正文、revision、Context manifest 和能力均由 Main 重建。
- **严格传输与容量**：两模式使用动态专用 named-tool schema；模型值与 runtime 共用 raw 边界，路径被收窄为本次实际读取集合。一次点击最多一次 provider call，无格式修复或自动重试；请求 ≤1 MiB、tool input ≤64 KiB、正文总计 ≤8 文件/240 KiB、`max_tokens=8192`、deadline 90 秒。最大 Unicode、精确 `+1`、missing/extra keys 和路径/证据歧义均有动态反例。
- **authority 与隔离**：每次明确点击获得随机 opaque navigation ID。缓存全局最多 8 条、TTL 30 分钟，以 owner/project/root/mutation generation/navigation epoch 隔离；淘汰、过期、reload、项目切换或 mutation 会撤销 action/lease 并 abort 在途 owner。`open` 可重复，Research/Changes 使用独立单次 action；后续 handoff 必须在副作用前再次调用 `assertLeaseCurrent`。
- **项目状态门禁**：生成前后均经过 Main watcher full-flush barrier；项目、generation 或 Renderer epoch 漂移不会安装结果。专用 provider adapter 把 service deadline/cancel signal 穿透 `runAiRequest` 到最内层 MiniMax fetch。模型字段、证据和 JSON 协议错误统一映射为内容无关提示，不再向作者显示内部字段名。
- **零写入与验证**：成功只安装短期 navigation authority，失败不触及 Markdown、History、Changes 或 mutation generation。`npm run verify:navigation` 为 **53/53**，Network boundary **15/15**；MiniMax **17/17**、Watcher flush **11/11**、Onboarding handler **11/11**、历史 Plan **26/26** 回归通过，`git diff --check` 与 changed JS `node --check` 通过。三轮独立复审最终 **P0=0/P1=0**。
- **明确未完成**：Main/preload wiring 仍只有源码级专项证明，尚未经过真实 Electron IPC；动作路由、pending Changes admission、结构确认 capability、骨架三态事务、Navigation Renderer、旧公开 Plan 移除、真实 Electron 和作者验收都未完成。当前不是发布候选。
- **下一执行顺序**：先完成 open/Research/Changes Main-owned handoff 与结构骨架全有或全无事务，再实现 Renderer 双模式和移除公开旧 Plan；随后运行完整回归、真实 Electron 与两段作者验收。

### 0.0BY 2026-07-31 · 旧 Plan 产品假设失效与写作导航合同冻结

- **第九次真实红灯**：operation **`db1c6915ed38430aa827e441666b8218`** 在 **22,312 ms** 后 `plan/failed`，UI 报“假设第 1 项应为 1–16 个字符”；before/after 0，`changes.json` 未变化，没有正文、History、ChangeSet 或 mutation 写入。
- **阶段判断**：九次失败横跨外围文本、数组 shape、block/ID、输出容量、依赖和叙述字段。Main 每次都正确 fail-closed，但继续逐字段补 Schema 只在优化模型服从率，并未验证专业作者需要里程碑/任务/依赖图。该循环至此终止。
- **产品决策**：公开 Plan 被替换而非隐藏或保留实验版。空项目使用“结构规划”比较 2–3 个结构并只创建空白章节骨架；已有稿件使用“写作导航”给出 1–3 个带文件/章节证据、时机、动作和预期结果的建议。动作仅为打开章节、补充来源、生成修改建议，后两者分别进入 Research/Changes。
- **工程边界**：每个合法项目仍必须有 `edit.md`，它是项目意图权威；栏目为空或未完成项目卡不阻止导航，但 UI 必须披露意图有限。技术性的跨文件目标/revision/顺序只在 Main 内部存在。旧 `writcraft.plan/v2` 和九次红灯保留为历史安全证据，不再派发修复或付费 canary。
- **当前完成度**：路线图、PRD、作者验收、Phase A、用户说明及新合同已同步；替代功能源码、测试、真实 Electron 与作者验收仍为开放项。下一步必须先独立审查合同，再改 Main/IPC/Renderer。

> **历史禁派发边界**：以下 0.0BX 及更早里程碑中的“下一动作 / 外部门禁 / 唯一下一步”只记录当时决策，均已被 0.0BY 取消。不得据此运行旧 Plan、MiniMax canary、Chapter/Inline 重测或创建旧验收副本；当前动作只看本文顶部、0.0BY 和 §4 TODO。

### 0.0BX 2026-07-31 · 真实 Plan 依赖自然语言与精确 ID 结构边界

- **真实红灯**：0.0BW 重启后，作者只执行一次约定目标。operation **`b915291982d14f8bb5520674280b3d0d`** 在 **13,590 ms** 后 `plan/failed`，UI 显示“里程碑 1任务 1依赖第 1 项应为 1–32 个字符”。before/after 均为 0；metrics 只新增失败事件，`changes.json` 仍停在 `2026-07-31T00:17:15.803Z`，没有缓存 Plan、任务卡、正文或 History 写入。
- **根因**：工具 Schema 虽给 `dependsOn` 单项 32 字符上限，但没有字段级声明“只能是此前任务的精确短 ID；首个任务必须 `[]`”，provider 把自然语言前置说明放入数组。Main 又曾复用会 `.trim()` 的通用文本 validator，存在把 `" t1 "` 静默修成 `"t1"` 的 Schema/Main 分歧。
- **生产修复**：milestone/task `id` 和 `dependsOn` 统一使用 `^[a-z][a-z0-9_-]{0,31}$`；Schema 增加字段说明与 `uniqueItems:true`，所有 Main ID/依赖校验不 trim、不猜测、不改写。提示明确首个任务依赖为空、后续只写此前短 ID。依赖长度、格式、重复或非法引用归入同一内容无关结构分类，与数组 shape 共享**一次**重试预算；失败 input 不进入重试 prompt，第二次仍错即停止，绝无第三次调用。
- **回归**：新增自然语言依赖→一次恢复、二次仍错→两调用终止、拒绝内容不回显、零写入，以及 spaced milestone/task/dependency 不得静默规范化的动态证明。Plan **26/26**、handoff **15/15**、UI **16/16**；完整 `npm test`、批准 GUI `npm run verify` 与强制真实 Electron **37/37** 全部通过。
- **独立复审与历史候选**：复审发现并推动关闭 trim、`uniqueItems` 与旧 TODO 漂移，最终 **P0=0/P1=0/P2=0**。生产修复、回归与同批文档曾提交为 exact candidate **`1c7f178`**；后续第九次失败已由 0.0BY 推翻“继续 canary”的旧动作，本节不得用于派发复测。

### 0.0BW 2026-07-31 · 真实 tool 请求命中输出上限与 Plan 生成 envelope 二次收敛

- **真实红灯**：作者使用权威目标只生成一次 Plan。operation **`706fa3e5529d4cda9cf0e2c3ecfe211c`** 在 **54,660 ms** 后返回 `MODEL_OUTPUT_TRUNCATED`，UI 显示“项目计划达到模型输出上限”。before/after 均为 0；`changes.json` 仍停在 Chapter 接受时间，未产生计划、任务卡、正文或 History 写入。
- **边界判断**：错误来自 provider 的稳定 `stop_reason=max_tokens`，不是 Renderer 文案误报、schema/request 过大或本地 parser 猜测。当前真实响应也证明 MiniMax 接受了 named tool 请求形态。现有隐私指标未记录 usage/block counts，因此“默认 thinking 消耗了多少 token”只能作为强推断，不冒充精确证据。
- **根因复核**：原工具 schema 仍沿用历史宽接收上限，理论允许 12 个里程碑、每个 12 个任务、Main 总 60 个任务和长说明/列表；独立复审构造的完全合法输入达 **418,984 bytes**。因此 8192-token provider 预算与合法生成空间没有闭合，一句“保持紧凑”不能成为容量门禁。
- **中国区文档纠偏**：笔触调用 `api.minimaxi.com/anthropic/v1`。当前公开中国区 Anthropic 文档尚未列出 M3，且对 `thinking` 同时出现“完全支持”与“部分兼容参数可能忽略”的冲突说明；不得采用国际站默认 adaptive 的说明来推断本次根因，也不得把显式 disabled 冒充修复。0.0BW 不新增 thinking 请求字段。
- **生产修复**：生成与 Main 接收使用同一个更小 schema：一次迭代最多 **2** 个里程碑、每个最多 **2** 个任务、总计 **4** 个任务；每任务最多 **2** 个目标文件和 **2** 个依赖，标题/摘要/目标/说明/列表同步缩短，路径保留 80 字符以覆盖当前作者项目。Renderer 同步限制总数和每里程碑任务数。Schema 与 Main 共同拒绝 C0 控制字符和孤立 UTF-16 surrogate，避免一个 JS 字符被 JSON 转义膨胀为 6 bytes；合法 surrogate pair/Emoji 保留，Main/Renderer 改按 code point 计数。填满全部 ID、80 字符唯一 Emoji 路径/叙述、所有唯一列表、双目标与前序依赖的最大合法 input 为精确 **6,120 bytes**，低于 6 KiB；跨文件双目标能力与 handoff 去重合同保留。唯一目标上限同步为结构真实可达的 8 个。0.0BV 的 13,758-byte 初稿只算显著收敛，不能证明 8192-token 闭合，已被本节取代。
- **默认模型与上下文边界**：网络适配器、Main 默认参数以及 Plan/项目卡/章节/研究调用均已使用 **MiniMax-M3**，不需要再次改名。模型名不等于应用会把 1M 材料直接发送；Plan 仍只读取作者显式选择的最多 8 个文件并受 240 KiB 聚合上下文门禁保护。中国区当前公开 Anthropic 文档尚未列出 M3 或 1M 上下文合同，本轮不在缺少官方/现场容量证据时放宽该安全门禁。
- **费用与失败策略**：全局与 Plan `max_tokens` 均保持 **8192**，90 秒 deadline 不变；不因一次截断盲目扩到 16K/32K，也不对 `max_tokens` 自动重试。即使截断响应带有看似完整的 tool input，Main 仍拒绝、只调用一次并保持零写入。
- **0.0BW 历史自动化与复审**：MiniMax adapter **17/17**；Plan **25/25 + 15/15 + 5/5 + 16/16 + 11/11**；最大合法 envelope、控制字符/孤立 surrogate 拒绝、完整 tool input 截断仍只调用一次/零写入、双目标 handoff 均有定向覆盖。该候选当时完整 `npm test`、批准 GUI 的 `npm run verify` 与强制真实 Electron **37/37** 通过，独立终审 **P0=0/P1=0/P2=0**；该数字已由顶部 0.0BX 当前证据取代。
- **候选与重启终态**：生产修复、回归和同批合同已提交为 exact candidate **`c6d8c44`**。开发 App 已从该提交重启；本轮没有自动输入、点击或发起付费调用。
- **当时下一动作（已取消）**：曾要求作者再做一次相同目标 Plan；0.0BY 已禁止执行。

### 0.0BU 2026-07-31 · 晚位重复字段再次失败与 Plan 工具协议迁移

- **真实红灯推翻旧结论**：作者改用短目标“把内容改简短一点”后，operation **`ef44ed234ceb417d9d8723fa918e3173`** 仍以 **107,623 ms** 失败，UI 报“里程碑 7任务 1目标文件必须是 0–8 项的数组”。before/after 均为 0，`changes.json` 未变化。长耗时证明同一操作的初次与唯一结构重试都已发生；0.0BT 只能提高格式服从概率，不能称为关闭。
- **根因升级**：让模型自由生成大型、深层、重复 JSON 时，提示词、示例和一次重试无法强制每个晚位任务字段保持同一类型。继续扩大提示或增加重试会重复付费和等待，属于同一问题的补丁循环。短目标更适合 Changes/Inline 是后续模式引导候选，但不是 schema 失败根因。
- **生产边界**：Plan 专用单工具 **`submit_project_plan`**，请求使用完整 JSON Schema 和 named `tool_choice`。网络适配器只暴露一个有界、同名、plain-JSON `tool_use.input`；Main 再做 exact keys、数组、ID、依赖顺序、路径存在性、总量与 revision 校验。thinking/text 块可共存但无 authority；没有/错误/多个/畸形 tool call 稳定失败，绝不降级到文本 JSON或本地修补。
- **0.0BU 当时的重试与零写入**：当时只对结构数组不合格共享一次重试预算；0.0BX 已把 ID/依赖引用结构纳入同一预算。第二次调用前始终重验树、`edit.md` 与显式上下文，不携带失败 input，绝无第三次。HTTP/鉴权/工具 envelope 失败不做格式重试。Plan 全程只读，任务写作仍必须经 Plan→Changes 审阅。
- **验证证据**：MiniMax adapter **17/17**；Plan **22/22 + 15/15 + 5/5 + 16/16 + 11/11**；完整 `npm test` exit 0。沙箱 `npm run verify` 在 DOM Electron `code=null` 红灯，同命令在批准 GUI 环境 exit 0。真实 Electron fixture 断言收到 forced tool/schema，以 thinking + text + tool_use 返回，并在第七里程碑第一个任务注入字符串。完整链保留两条不稳定红灯：一次 Plan 已通过后的 Chat 后段 CDP `Runtime.evaluate` timeout，一次 Plan 前等待项目卡进度 timeout；两者同源码单次确认均未复现，最终 **37/37**。它们保留为测试时序 P2 证据，不作为产品回归，也没有通过产品补丁掩盖。
- **当时外部门禁（已取消）**：曾要求当前作者 profile 复验 named forced 形态；0.0BY 已停止该 provider canary。
- **独立复审**：首轮发现“一个合法 + 一个错误/畸形 tool_use”可能绕过唯一性 P1，以及请求临界测试未证明 schema 字节计入上限的 P2；前者改为分别统计原始/合法调用，后者让生产与测试共用 `providerRequestBody` 并构造 tools 决定越界的临界 fixture。合同中残留的 `end_turn` 文本 JSON 说明同步纠正。复审最终 **P0=0/P1=0/P2=0**。
- **候选与启动终态**：源码、回归和相关合同已提交为 exact production candidate **`054ce2b`**，当前仅为本地提交，尚未推送或发布。开发 App 已从该候选重启并只读确认仍加载第七作者副本、第一章、“编辑器就绪 / 已保存”；没有自动输入、点击或发起付费调用。
- **当时下一动作（已取消）**：曾要求生成一次真实 Plan 并交接 Changes；0.0BY 已终止该路线。

### 0.0BT 2026-07-31 · 真实 Plan 第二任务数组结构 P1 与共享单次重试

- **真实红灯**：`0e7ad38` 重启后，保留目标又产生两次 `plan/failed`：operations **`0b5e7919191846c08b3bf15de1a76d0a` / `79bca23cc98b480798967515b594650f`**，耗时 **57,477 / 77,039 ms**，before/after 均为 0。可见错误为“里程碑 1任务 2目标文件必须是 0–8 项的数组”，证明模型已经进入 strict JSON，却把第二个任务的 `targetPaths` 返回成字符串等非数组形状。
- **根因**：0.0BS 的一次自动重试只识别 `PERIPHERAL_TEXT`；prompt 虽给出单任务示例，却没有明确“每个任务、尤其后续任务”的三个列表字段都必须重复使用数组结构。因此外围文本修复后，下一层合法 JSON/错误 schema 直接漏到用户界面。
- **零写入证明**：两次新指标均为 `plan/failed`、before/after 0；作者副本章节哈希保持 `b0462641…`，原稿保持 `1bdb3a5c…`；`changes.json` 仍停在 Chapter 接受时间。没有 Plan、任务卡、正文或 History 写入。
- **生产修复**：candidate **`94e6099`** 不把字符串猜成路径数组，也不降低 exact-key/schema 校验。首轮提示明确每个里程碑/任务都须完整重复结构，所有列表字段必须是 JSON 数组，未知 `targetPaths` 使用 `[]`。Main 只对精确外围文本或数组形状错误共享一次重试预算；失败输出不进入重试 prompt，重试前重验全部冻结依赖；第二次仍错立即终止，绝不出现第三次模型调用。
- **防复发与验证**：新增 `npm run verify:plan`，固定从 `package.json` 执行五个现存 Plan 门禁，避免再凭记忆拼错测试文件名。定向 **22/22 + 15/15 + 5/5 + 16/16 + 11/11**；完整 `npm test` exit 0；沙箱 `npm run verify` 在 DOM Electron 以 `code=null` 红灯，原命令在批准 GUI 环境 exit 0；真实 Electron 用“第二任务 `targetPaths` 为字符串”直接复现并证明同一次点击恢复、Markdown/History 零写入，完整 **37/37**。
- **保留的过程红灯**：本轮曾调用不存在的 `tests/verify-v0-plan-handoff-integration.js`；这是命令入口错误而非产品失败。新增固定 `verify:plan` 脚本将经验转为执行门禁。独立复审与一次真实同目标复验仍待完成。

### 0.0BS 2026-07-31 · 真实 Plan 外围文本 P1 与同操作有界格式重试

- **真实红灯**：作者使用权威建议目标生成 Plan，UI 三次稳定报告“AI JSON 包含外围文本”。私有指标记录 operations **`ba09ce4c46f8424a99fbb300439d413c` / `5fe259aa74b64004ab9f917f35c118c1` / `cf06a7b0a2694acbb8d33bfe43fd9d79`**，耗时 **47,122 / 37,843 / 39,474 ms**，全部为 `plan/failed`、before/after 0。第三次后停止人工重试。
- **根因**：Plan parser 有意只接受一个 strict JSON 对象并正确拒绝围栏和外围说明，但生产 prompt 只说“只返回 JSON”，没有像 parser 一样明确首尾字符、代码围栏、前后解释、第二对象与未知字段边界。模型连续服从了自然语言回答习惯；作者输入与 `edit.md` 均无错。
- **零写入边界**：三次失败均未创建 Plan task、pending handoff、ChangeSet 或 History，也没有修改项目 Markdown。不得通过截取首尾大括号、本地剥离围栏或猜测内容冒充成功。
- **生产修复**：初次提示明确首个非空白字符 `{`、最后一个 `}`，禁止围栏、外围文本、说明、注释、第二 JSON 与未知字段。只有错误被 strict scanner 精确分类为 `PERIPHERAL_TEXT` 时，Main 才在同一作者操作内最多重试一次；不携带或回显失败模型输出。重试前重新读取文件树并逐个核对冻结的 `edit.md`/显式上下文 revision 与正文；任何漂移以 `PLAN_DEPENDENCY_STALE` 在第二次付费调用前失败关闭。第二次仍不严格则终止，绝不递归重试。
- **可见体验**：加载页明确说明“格式不合格时最多自动重试一次”，避免额外等待被误解为卡死；一次点击仍只形成一个内容无关 metrics operation。
- **验证**：Plan service **21/21**，新增自动恢复、不回传 `LEAK_MARKER`、最多两次调用、依赖漂移仅一次调用；Plan UI **16/16**、Plan handoff **15/15 + 5/5**、Assistant **11/11**。完整 `npm test`、批准 GUI `npm run verify` 均 exit 0。真实 Electron fixture 首次返回“说明 + fenced JSON”，只在第二个 prompt 含唯一格式重试标记时返回 strict JSON；同一次点击出现任务卡，Markdown 与 History 字节不变，完整链 **37/37**。
- **候选**：生产修复、回归测试、权威文档与开发指引已提交为 exact candidate **`0e7ad38`** 并推送 `origin/main`；未发布 npm/GitHub Release。
- **测试过程红灯**：曾误调用不存在的 `tests/verify-v0-project-plan-handler.js`，Node 以 `MODULE_NOT_FOUND` 退出；这是测试入口选择错误，不是产品失败。随后先用 `rg --files tests` 确认真正入口并运行 Plan handoff/Main factory 现有覆盖。后续不得凭记忆编造测试文件名。
- **历史验收边界**：当时要求真实提供商复验；0.0BY 已终止该路线。不得再点击“生成计划”或以 Plan task handoff 作为当前门禁。

### 0.0BR 2026-07-31 · 第七副本 Chapter 接受与提交后终态真相

- **真实操作**：作者在第七 fresh 副本对第一章输入“写的简短一些”，成功获得完整 Diff 并明确接受。operation **`2acf8b66959744f0bedd1d94bbe31eab`** 为 **50,103 ms `generated` → 31,915 ms `accepted`**。
- **History 与磁盘**：唯一 post-manifest History 为 **`change_b00d7f9d-c8ae-4b84-a003-589d515e1eda`**，状态 `application/applied`，路径只包含 `chapters/01-cope-origin/chapter-01-why-cope.md`。before revision **`1bdb3a5c646b61dc01dcc1328f6e0039a34d6986cbb17230164591f4d947ef8b`**，after revision **`b04626419b89f415a9dc85d97dedf09dd44447ebddf21f389f704f9c0aad14ce`**；当前磁盘 SHA-256 与 after 精确一致，文件为 15,092 bytes。
- **原稿隔离**：确认源对应第一章仍为 16,931 bytes / before revision；原稿项目 preflight digest 保持 **`9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`**。没有误写原稿或其他 Markdown。
- **现场 UX 红灯**：AX 同时读到编辑器“已按磁盘、文件树和修改历史确认本次操作”、底部“已安全应用 1 个文件”，以及旧 hunk 卡“已选择接受 · 尚未写入”。写盘与 History 成功，但 Renderer 在可信无 residual 终态把 `pending=null` 后没有替换旧 preview DOM，造成陈旧且相互矛盾的提示。
- **生产修复**：可信提交且无 residual 时，隐藏提交按钮、清空全部旧 Diff/决定，并只显示“审阅已完成 · [权威终态]”。预提交阶段的“尚未写入”文案继续保留；只有提交后才消失，不会混淆审阅与落盘边界。
- **验证**：Changes UX **9/9**、Onboarding Renderer dynamic **30/30**；动态测试证明权威 reload 无重复 IPC、终态无 `尚未写入` 且 hunk 卡为 0。真实 Electron 的 Chapter 阶段新增相同断言；完整 `npm test`、批准 GUI `npm run verify`、强制真实 Electron **37/37** 均通过。
- **候选与重启终态**：源码、测试和同批文档已提交为 exact candidate **`4bef659`** 并推送 `origin/main`。同一第七副本在该提交重启后仍显示作者验收项目、第一章已接受正文与“编辑器就绪 / 已保存”；磁盘 SHA-256 仍为 after **`b0462641…`**，源稿仍为 before **`1bdb3a5c…`**，且没有待审阅面板或旧 hunk 卡。
- **验收边界**：真实 Chapter 生成、审阅、写盘、History 与重启恢复已通过，Chapter 关闭，不要求作者重复付费生成与内容决定。当时的“下一段只做 Plan”已由 0.0BY 取消。

### 0.0BQ 2026-07-31 · `2073406` 第七 fresh Chapter 验收副本

- **候选**：动态 blockId 修复、非默认 ID 单元 canary、真实 Electron fixture canary 及同批权威文档已提交为 exact production candidate **`2073406`** 并推送到 `origin/main`；未发布 npm/GitHub Release。
- **复制事务**：在既有所有者授权范围内，从未变验收源创建 `/Users/maxhou/Desktop/Max 项目-2026/WritCraft 作者验收/WritCraft-0.1.2-作者验收-7`。事务返回 `copyCreated=true / sourceUnchanged=true`，20 files / 608,433 bytes；源 digest 仍为 **`9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`**。
- **副本门禁**：含私有 manifest 后仍 eligible：12 chapters、4,748 可见中文字符、1 source、21 files / 608,530 bytes，digest **`c3ac9344156389c60cb54df915e5ef744c8b1671538b7acc942ebbf95f6b3424`**。
- **启动核验**：第六副本实例以 SIGINT 正常退出；新 `npm start` 已加载当前源码。macOS AX 只读确认源码 URL、项目标题 **`WritCraft-0.1.2-作者验收-7`**、`edit.md` revision **`e9e9f7c…`** 与“编辑器就绪 / 已保存”。自动化未选择正文、输入要求或触发 AI。
- **当时唯一下一动作（已完成且失效）**：作者曾按本节完成第一章 Chapter；后续继续 Plan 的要求已由 0.0BY 取消。

### 0.0BP 2026-07-31 · Chapter 动态 blockId 模板冲突 P1

- **真实红灯**：作者在第六 fresh 副本再次按要求生成第一章。operation **`814b0f1e23be4d5683e009d1802afe82`** 为 `file / changeset / failed`，耗时 **24,830 ms**，before/after 均为 0；UI 明确报告“章节区块 b2 与 Main 计划不匹配”。
- **零写入证明**：第六副本仍有 14 个 Markdown、**97,313 bytes**，与原始验收源逐文件 hash 差异为 **0**；History 总数仍为 manifest 前继承的 3 条，最新时间早于副本创建。原稿预检继续 eligible，digest 仍为 **`9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`**。
- **精确根因**：Main 当前区块和完整计划都正确传入动态 ID，但同一提示中的“精确格式”被硬编码为 `blockId:"b1"`。模型在第二个区块服从该示例返回 `b1`，随后 Main 正确要求 `b2` 并 fail-closed。不是作者输入、供应商随机故障或校验过严，而是生产提示内部自相矛盾。
- **生产修复**：精确示例改为从当前 `block.id` 与 `BLOCK_SCHEMA` 同源 `JSON.stringify` 生成；不猜测模型意图、不把错误 ID 改写为正确 ID，也不放宽 strict schema/blockId 校验。
- **测试补洞**：现有多区块测试新增 `opening`/`turn` 两个非默认 ID 的完整提示断言，并明确排除写死的 `b1`；真实 Electron fixture 要求收到 `blockId:"whole"` 才继续。Chapter **21/21**、完整 `npm test`、批准 GUI `npm run verify` 和强制真实 Electron **37/37** 全部通过。
- **流程教训**：动态协议字段不能在 prompt 示例、校验器和测试 fixture 中各自维护常量。示例必须由 Main 当前权威对象生成；测试不仅要模拟“模型返回正确结果”，还要读取实际发送的 prompt，并用非默认值证明提示与校验器一致。第六副本不再重试；新候选使用第七 fresh 副本。
- **门禁**：独立复审和真实作者通过仍未完成，不得发布 0.1.2。

### 0.0BO 2026-07-30 · `5eb11bd` 第六 fresh Chapter 验收副本

- **候选与原稿**：生产候选精确为 **`5eb11bd`**；后续 `9de0ddf` 只回填候选哈希。复制前原稿预检仍为 eligible：12 chapters、4,748 可见中文字符、1 source、20 files / 608,433 bytes，digest **`9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`**。
- **复制事务**：在既有所有者授权范围内创建 `/Users/maxhou/Desktop/Max 项目-2026/WritCraft 作者验收/WritCraft-0.1.2-作者验收-6`；事务返回 `copyCreated=true / sourceUnchanged=true`。包含私有验收 manifest 后，副本预检仍 eligible：21 files / 608,530 bytes，digest **`add55a3f7703f4120c1b7d64a86559c85d320d316d19f1ccc401a4d55d521486`**。
- **启动核验**：旧源码实例以 SIGINT 正常退出；新 `npm start` 已加载当前源码。macOS AX 只读核验确认窗口为源码 `file://.../v0/src/renderer/index.html`，项目标题 **`WritCraft-0.1.2-作者验收-6`**，当前 `edit.md` revision **`e9e9f7c…`**，状态为“编辑器就绪 / 已保存”。没有代作者选择正文、输入要求或触发 AI。
- **唯一下一动作**：作者打开 `chapters/01-cope-origin/chapter-01-why-cope.md`，进入“跨文件修改”，保持只选该正文，输入真实要求后点击“生成当前章节”。若出现完整可审阅 Diff，由作者自行接受或拒绝；自动化只在操作后核对 metrics、History、磁盘与源摘要。项目卡和 Inline 不重跑。

### 0.0BN 2026-07-30 · 真实 Chapter `b5.content` P1 与有界重试候选

- **真实红灯**：作者在第五副本对第一章输入“写的简短一点”。严格计划与前四个区块均完成，区块 `b5` 在内容门禁失败；指标 operation **`522039856a144b0abe1e11a3ed69f46b`** 为 `file / changeset / failed`，耗时 **41,393 ms**，before/after 均为 0。
- **安全真相**：该失败没有创建可审阅 ChangeSet、没有新增 History、没有修改正文。失败后 14 个 Markdown 仍为 **97,313 bytes**，第一章 SHA-256 仍为 **`1bdb3a5c646b61dc01dcc1328f6e0039a34d6986cbb17230164591f4d947ef8b`**，相对验收源逐文件差异为 **0**。
- **根因边界**：旧校验把空内容、外层换行、字符/字节超限折叠为同一错误，并在任一区块失败时丢弃此前生成结果，既无兼容性的传输规范化，也无受控的单区块重生。历史调用没有保存模型正文，所以不能臆测 `b5` 究竟为空、外层换行还是超限；能够确认的是产品门禁和恢复体验不足，不是作者操作错误。
- **生产修复**：严格 JSON/schema/block id 仍不修补、不重试。只对 content 类型、空白、NUL、字符或字节边界做稳定分类；CRLF 与外层换行作为传输格式规范化。首次内容失败时重新核验 `edit.md`、目标文件与只读上下文 revision，全章总计只允许一次当前区块重生；重试提示不携带失败模型正文。第二次不合格则明确零写入终止。
- **可见体验**：生成进度明确披露“单个区块不合格时最多重试一次”，避免作者把额外等待误解为卡死。成功仍只进入完整文件审阅，绝不自动写盘。
- **验证证据**：Chapter **21/21**，新增外层换行规范化、一次重试、二次失败零写入及 retry 前依赖漂移门禁；完整 `npm test` exit 0。沙箱 `npm run verify` 仅在真实 DOM Electron 启动以 `code=null` 失败，批准 GUI 的同命令 exit 0。随后强制真实 Electron fixture 让首个 Chapter 区块先返回空内容，只有收到一次重试标记才返回有效内容，完整链 **37/37**。
- **候选与历史人工边界**：修复、测试和同批文档已提交为 exact candidate **`5eb11bd`** 并推送到 `origin/main`，但不冒充真实作者通过。当时创建 fresh 副本并重跑 Chapter 的动作已完成；Plan 复测由 0.0BY 取消。

### 0.0BM 2026-07-30 · 第五副本 Inline Safe Undo 通过

- **作者动作**：作者只撤销了界面最上方、明确标记“最新”且精确指向 `chapters/01-cope-origin/chapter-01-why-cope.md` 的 **`change_6516ccbc…`**；没有触碰旧 `manuscript/...` 或任何 `edit.md` 记录。
- **History 真相**：同一 application History 保留原 `appliedAt = 2026-07-30T14:59:34.329Z`，状态变为 **`undone`**，`undoneAt = 2026-07-30T15:06:45.243Z`；before/after revision 继续封存 `1bdb3a5c… → f9b89aac…`，没有伪造新 application。
- **磁盘恢复**：第一章当前 SHA-256 精确恢复为 **`1bdb3a5c646b61dc01dcc1328f6e0039a34d6986cbb17230164591f4d947ef8b`**。14 个 Markdown 回到 **97,313 bytes**，组合摘要精确恢复操作前基线 **`7ead5eaa21d1432a2ac6c27ee24913c03b68a495b2bc9daa3c3796a0c3a6d362`**；相对验收源逐文件差异为 **0**。
- **真实 UI**：当前第一章状态栏显示 **“原文已恢复 · 已按磁盘、文件树和修改历史确认本次操作”**；Changes 显示 **“安全撤销已结束”** 与 **“已撤销 1 个文件”**，不再把已撤销记录作为可撤销的最新卡片。
- **原稿与指标**：原始验收源继续 eligible，snapshot digest 仍为 **`9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`**。接受/拒绝四条内容无关指标保持原样；Safe Undo 不伪造 AI operation。
- **结论与当时下一步**：`9b21a9d` 的 Inline v2 真实作者子旅程完成并关闭，不再重跑。当时的 Chapter 已完成；Plan handoff 后被 0.0BY 取消。

### 0.0BL 2026-07-30 · 第五副本 Inline 接受与拒绝通过

- **作者实际顺序**：作者第一次输入真实改写要求、生成 Diff 后明确接受；随后用新的 operation 再次生成并明确拒绝。两个场景必须分别记账，不能因顺序与提示不同而要求作者重复。
- **接受 operation**：`cd20e785…` 为 **5,143 ms `generated` → 4,032 ms `accepted`**，字符计数 32 → 44。唯一 post-manifest History 为 **`change_6516ccbc…`**，`application/applied`，目标精确为 `chapters/01-cope-origin/chapter-01-why-cope.md`；before revision **`1bdb3a5c…`**、after revision **`f9b89aac…`**，当前磁盘 SHA-256 与 after 精确一致。
- **拒绝 operation**：`8f093bb9…` 为 **4,807 ms `generated` → 2,151 ms `rejected`**，预览 44 → 76 字符，拒绝终态回到 44。该 operation 发生在接受写盘之后，但目标 mtime 仍为接受时的 `2026-07-30T14:59:34.333Z`，没有第二条 post-manifest History；桌面终态明确显示 **“原文已恢复”**。因此它证明的是“保留第一次已接受真相、拒绝第二次建议零额外写入”。
- **项目与原稿边界**：当前 14 个 Markdown 合计 97,349 bytes，组合摘要 **`0a526eb1c963cf51d73df8bbb42e7061be3c1beb2283621ae22eca7c7635ed3d`**；相对验收源只有上述第一章发生变化。原始验收源仍 eligible，snapshot digest 继续为 **`9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`**。
- **下一步唯一目标**：桌面修改历史已展开，最上方卡片明确显示 **`chapters/01-cope-origin/chapter-01-why-cope.md 最新 · 已应用 7/30 22:59`**，对应按钮 aria-label 为“安全撤销：chapters/01-cope-origin/chapter-01-why-cope.md”。作者只撤销这张 **`change_6516ccbc…`**；不得点击其下方旧 `manuscript/...` 或两条 `edit.md`。完成后必须证明正文恢复 `1bdb3a5c…`、该 History 进入 undone 终态且原始源不变。
- **证据口径纠正**：0.0BK 曾直接读取不存在的 `changes.json.history`，把继承 History 总数误写为 0。权威 `changeHistoryService.listHistory()` 证明第五副本基线继承 **3** 条、manifest 后为 **0** 条；接受后总数 **4**、本轮新增 **1**。错误只在证据解析与文档，不影响磁盘、History 服务或作者操作。

### 0.0BK 2026-07-30 · `9b21a9d` 第五 fresh Inline 验收副本

- **候选绑定**：生产源码仍精确绑定 **`9b21a9d fix(inline): require author rewrite instruction`**；后续 `c33565e` 及本节只收口文档，不改变候选行为。Inline v2 第三轮独立复审为 **P0=0/P1=0/P2=0**。
- **只读源门禁**：已确认验收源再次预检为 eligible：`edit.md` valid、12 chapters、4,748 可见中文字符、1 source、20 files / 608,433 bytes；snapshot digest 仍为 **`9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`**。
- **复制事务**：在既有所有者授权范围内创建 `/Users/maxhou/Desktop/Max 项目-2026/WritCraft 作者验收/WritCraft-0.1.2-作者验收-5`。事务返回 `copyCreated=true / sourceUnchanged=true`、20 files / 608,433 bytes；副本自身含私有验收 manifest 后为 eligible、21 files / 608,701 bytes，digest **`7002be616c01f0b25592597e0ffad6557a26396d08c096835fe37db4079310f9`**。
- **计数边界**：manifest `createdAt = 2026-07-30T14:48:31.566Z`。副本继承的 metrics 23 条与 History 3 条均早于该时间，不能冒充本轮证据；manifest 后新增指标/History 均为 0，只计算该时间之后绑定第五副本的事件和磁盘变化。
- **操作前 Markdown 基线**：排除 `.writcraft` 后，对 14 个 `.md/.markdown` 的规范相对路径和精确文件字节做长度分隔 SHA-256，得到 **`7ead5eaa21d1432a2ac6c27ee24913c03b68a495b2bc9daa3c3796a0c3a6d362`**；合计 97,313 bytes，最大 mtime `2026-07-30T14:48:31.562Z`。接受允许一次有 History 的明确推进；其后的拒绝必须保持接受后的 hash/mtime、且不新增第二条 History。
- **验收范围**：项目卡证据由第四副本继承且不受 Inline v2 生产变化影响，禁止重复。作者只需在普通 `chapters/` 正文完成三个独立动作：`⌘K` 输入真实改写要求后拒绝；新的 operation 接受；从明确标记为最新且精确指向该正文的 History 执行 Safe Undo。自动化不得代选文本、代填指令或代作审阅决定。
- **启动入口**：稳定 profile 只读显示 AI Key 已配置为 Coding Plan；旧候选实例已正常退出，recent-project 已通过项目服务指向第五副本。桌面只读核验确认源码 App 已打开第五副本且没有残留 Diff 或恢复锁；当前已导航到 `chapters/01-cope-origin/chapter-01-why-cope.md`、状态“已保存”。自动化没有选择文字、输入指令或触发 AI，唯一下一动作仍须由作者完成。

### 0.0BI 2026-07-30 · 第四副本真实作者项目卡通过

- **作者操作**：作者本人在第四 fresh 副本填写、生成、审阅并提交项目卡，第二阶段选择跳过初始文件。自动化没有代填、代选 hunk 或代做内容判断。
- **指标与 History**：manifest 后 operation **`32b817da…`** 记录 **7,037 ms `generated` → 31,481 ms `accepted`**。新增 History **`change_5417c8da…`**，类型 `application`、状态 `applied`、文件仅 `edit.md`；接受 **2** 个 hunk、拒绝 **0**。
- **磁盘真相**：第四副本 `edit.md` SHA-256 从 **`e9e9f7c2…`** 更新为 **`8b68a5b18e6469a9ad4d0f7cff321b15c5f631bd02e9a2bd9c3a864b1d6772b3`**，与 History after revision 精确一致；History before revision 与初始 hash 精确一致。
- **修复现场闭环**：桌面界面显示 revision **`8b68a5b…`**、磁盘/文件树/修改历史确认，并明确显示 **“已跳过初始文件创建；edit.md 已保留本轮接受的更新”** 与 **“项目卡已完成；edit.md 更新已保留，没有创建初始文件”**。0.0BG 的陈旧终态 P1 在真实作者路径关闭。
- **原稿隔离**：只读 preflight 仍为 eligible、12 章节、4,748 可见中文字符、1 source、20 files / 608,433 bytes；snapshot digest 仍为 **`9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`**，源 `edit.md` 仍为 **`e9e9f7c2…`**。
- **下一步**：项目卡子旅程已关闭，不得要求作者再次重复。下一项是在一篇普通 `chapters/` 正文中选择一小段，发起 Inline Rewrite 并明确拒绝；完成后先证明正文和 History 零写入，再进入独立接受与 Safe Undo。

### 0.0BJ 2026-07-30 · `⌘K` 必填作者指令 P1

- **现场发现**：作者在第四副本完成一次真实 Inline 接受后指出，按 `⌘K` 没有输入改写要求的入口。PRD 与原始交互语义确认：`⌘K` 是选区 Inline Rewrite，必须先输入自然语言要求；`⌘L` 是项目/文件/选区对话，不承载该次行内改写命令。
- **生产修复**：选区旁新增轻量指令框。打开只冻结 Range 和项目/文件/编辑会话身份，不保存、不发 IPC、不记录指标、不调用 AI；Enter（非 IME composing）提交，Esc 零副作用取消，重复 `⌘K` 聚焦原输入，`⌘L` 取消未提交输入后打开 Chat。提交前再次校验 Range、offset、digest、revision、dirty generation 和会话身份。
- **协议与隐私**：请求升级为 exact v2，指令须 NFC/trim、1–500 code points、≤2 KiB UTF-8、单行且拒绝控制/双向/零宽/孤立代理字符；完整请求 ≤8 KiB、模型消息 ≤40 KiB。Main 在 `beginGeneration` 前校验，作者要求优先于辅助风格，写作资料保持不可信。原始指令及其 hash 不进入 review、History、metrics、recovery、诊断、错误或日志。
- **红灯与修正**：第一次真实 Electron 因把规则拆成 `system` role 而被现有 MiniMax Anthropic 适配层预先拒绝；改为单条 `user` 消息内的显式优先级，未放宽网络角色契约。后续一次完整 E2E 在无关 Graph 鼠标 CDP 命令超时；同源码完整复跑 37/37，登记为待解释的非阻塞测试驱动波动，不能用绿灯抹除。
- **验证、复审与候选**：Inline Context **15/15**、Main service **11/11**、Renderer transaction **14/14**、Main/preload integration **7/7**、Renderer UI **11/11**；完整 `npm test` exit 0，批准 GUI 的 `npm run verify` exit 0，最终强制真实 Electron **37/37**。首轮独立复审发现 instruction/style 优先级与 composer Range 证明两个 P1，以及四个证据/生命周期 P2；修复后第二轮为 P0=0/P1=0/P2=3，补齐指标落盘 canary、真实 Electron三条关闭生命周期和文档精度后，第三轮最终 **P0=0/P1=0/P2=0**。代码、测试与同批文档已提交为新 exact production candidate **`9b21a9d`**；本节后的纯文档收口不改变生产候选。
- **验收影响**：项目卡证据不受影响；旧候选上的 Inline 接受仅保留为缺口发现证据。新 exact candidate 和 fresh 副本只重跑 Inline 拒绝、接受、Safe Undo，不再要求作者重复项目卡。

### 0.0BH 2026-07-30 · 第四个 fresh 作者验收副本就绪

- **候选门禁**：exact production candidate **`5ed4147`** 已完成完整 test/verify、真实 Electron 37/37、npm Preview 10/10、三套 installed 2/2、生产审计 0 vulnerabilities；独立复审 **P0=0/P1=0/P2=1**，唯一文档精度 P2 已由后续 docs-only 提交关闭。
- **复制事务**：在作者既有授权范围内，从 `/Users/maxhou/Desktop/Max 项目-2026/写作项目 test-WritCraft验收源` 创建 `/Users/maxhou/Desktop/Max 项目-2026/WritCraft 作者验收/WritCraft-0.1.2-作者验收-4`。事务返回 **20 files / 608,433 bytes / sourceUnchanged=true**；复制前后的只读 preflight 都为 eligible，source digest 均为 **`9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`**。
- **计数边界**：副本 manifest `createdAt = 2026-07-30T13:12:06.288Z`。只允许晚于该时间且绑定第四副本的 metrics/History 计入本轮；源内旧记录不计。
- **启动核验**：旧 candidate App 已以 SIGINT 正常终止；新 `npm start` 使用稳定 profile 启动。桌面 AX 只读核验确认标题为 **WritCraft-0.1.2-作者验收-4**，当前文件 `edit.md`，初始 revision **`e9e9f7c…`**，编辑器已保存。
- **作者下一步**：点击左侧 **项目卡**，由作者本人填写、生成、审阅并提交；第二阶段可选择不创建初始文件。成功终态必须明确显示 `edit.md` 更新已保留。完成后先核验 metric、History、磁盘 hash 与原稿 digest，再推进 Inline/Chapter/Plan。

### 0.0BG 2026-07-30 · 已提交 edit.md 后跳过文件创建的终态真实性

- **成功写入证据**：第三副本第二次项目卡 operation 为 **`generated → accepted`**。History 新增 `change_f9ad076f…`，`application/applied`，只含 `edit.md`，before **`e9e9f7c…`**、after **`3ab121f…`**；接受 2 个 hunk、拒绝 0 个。界面编辑器 revision 与 after 一致，状态栏确认磁盘、文件树和修改历史。
- **现场 P1**：作者在第二阶段选择“跳过文件创建”后，Changes 终态无条件显示“已放弃初始文件创建；edit.md 的结果保持不变”。当 `editNoChanges=false` 时这与已提交事实矛盾，会使作者误判审阅是否生效；不造成数据损坏，但阻断可理解的提交终态。
- **生产修复**：跳过文件创建现在按第一阶段真相分支。已提交 edit 时显示“edit.md 已保留本轮接受的更新”及“项目卡已完成”；确实无 edit 变化时才继续显示“结果保持不变”。指标结算、Main capability 与磁盘事务均未放宽。
- **动态回归**：Onboarding Renderer dynamic 新增完整 `acceptProposal → accept hunk → apply → discard confirmation` 回调，断言 accepted metric、已保留文案和禁止陈旧“保持不变”，总数 **30/30**；Changes UX **8/8**。
- **保留红灯与测试根因**：首次和第二次完整 `npm test` 都在 posttest 的 native Markdown trash helper 以 `bind timed out` 红灯、各 19/20，但失败用例不同；聚焦复跑 20/20。测试曾把 helper bind/普通恢复等待预算硬编码为 1 秒，完整套件连续 clang 编译/启动会跨过该偶然窗口。现以命名常量将测试专用 bind/普通恢复预算改为 5 秒，生产默认仍为 30 秒，`ready()` 后的 crash/unknown 注入继续设置 100ms。修正后聚焦 20/20，完整 `npm test` exit 0。
- **新候选与全门禁**：修复提交为 exact candidate **`5ed4147`**。完整 `npm run verify` 在沙箱的真实 DOM Electron 以 `code=null` 退出，原样在批准 GUI 环境 exit 0；强制真实 Electron 沙箱因 `listen EPERM 127.0.0.1` 失败，批准 GUI 环境 **37/37**。npm Preview **10/10**；installed 烟测沙箱保留 `PROCESS_SNAPSHOT_FAILED` 红灯，批准环境本机与 Node 22/npm 10 arm64、Node 24/npm 11 x64 均 **2/2**；联网生产依赖审计 **0 vulnerabilities**。dry-run 包为 **120 files / 574,848 bytes / 2,631,510 unpacked / shasum `65af5cedcc154dcf3099284240e8b16a755b3696`**。
- **独立复审与重启顺序**：只读复审逐项核对 committed/no-op 分支、Main confirmation mint、metric/History、真实回调测试和 worker timeout，结论 **P0=0/P1=0/P2=1**。唯一 P2 是测试 5 秒常量同时覆盖 bind 和普通恢复请求，不能称为 startup-only；本次 docs-only 已纠正表述，生产 30 秒与 post-readiness 100ms 注入均未改变。`30a06b0` 和第三副本项目卡证据仍失效；现在允许从未变源创建第四 fresh 副本，五段旅程从项目卡重跑。

### 0.0BF 2026-07-30 · 项目卡首次操作为安全零写入，尚未通过落盘门禁

- **作者操作终态**：作者报告“项目卡已接受”，但运行时界面显示“已放弃初始文件创建；edit.md 的结果保持不变”和“已结束项目卡确认，没有创建初始文件”。本轮 post-manifest 私有指标为同一 operation 的 **`generated` → `discarded`**，新增 History **0**。
- **磁盘与源真相**：副本和原始验收源的 `edit.md` SHA-256 均为 **`e9e9f7c2a4a83a1de2e4b5e31c92ad57eb625eea32c31f613d1aaf3da98a87c5`**；原始源只读预检仍为 eligible、12 章节、4,748 可见中文字符、1 个来源、20 files / 608,433 bytes，snapshot digest 仍为 **`9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`**。没有误写原稿或正文。
- **验收判断**：该操作证明生成后放弃能保持零写入，但不满足 `ROADMAP.md` §4.2 的 **项目卡 → edit.md ChangeSet → 人工确认 → 磁盘落盘**，不得标为旅程通过，也不得进入 Chapter/Plan。
- **最短补验收**：作者重新打开项目卡，在任一答案中加入一个现有 `edit.md` 不包含、且确实想长期保留的项目约束；生成后接受至少一个 `edit.md` 修改块并提交审阅决定。第二阶段的初始文件仍可选择不创建。完成后先核验新 edit hash、application History、accepted metric 和原始源 digest，再推进下一旅程。

### 0.0BE 2026-07-30 · 安全暂停于真实作者项目卡门禁

- **重复门禁**：第三副本启动后连续三个目标回合均未出现作者项目卡操作。每轮只读核验都确认目标副本仍打开，manifest 之后 metrics/History 均为 **0**；没有把源内旧 `edit.md` 或旧 `.writcraft` 记录误计为第三轮证据。
- **安全状态**：App 进程继续运行；Git 工作区在本记录前保持干净；没有代填项目卡、代做审阅决定、触发付费调用或发布 0.1.2。
- **唯一解除动作**：作者本人切换到“笔触”，点击左侧 **项目卡**，完成填写、生成及接受/拒绝决定，然后把结果反馈给开发任务。解除后先核验文件、History、metrics 与源快照，再进入 Chapter/Plan；不得降低真实作者验收标准或用自动化绕过。

### 0.0BD 2026-07-30 · 第三个 fresh 作者验收副本就绪

- **门禁输入**：production candidate **`30a06b0`**；后续 `b6041b6` 只修正文档时态，不改变候选。第二轮独立复审 **P0=0/P1=0/P2=1（docs-only 已关闭）**。
- **复制事务**：作者既有授权范围内，从 `/Users/maxhou/Desktop/Max 项目-2026/写作项目 test-WritCraft验收源` 创建 `/Users/maxhou/Desktop/Max 项目-2026/WritCraft 作者验收/WritCraft-0.1.2-作者验收-3`。事务返回 **20 files / 608,433 bytes / sourceUnchanged=true**；复制前、事务返回和复制后只读预检的 source digest 均为 **`9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`**。
- **计数边界**：副本 manifest `createdAt = 2026-07-30T10:56:11.255Z`。源内已有 `.writcraft` 私有历史继续保留，但仅晚于该时间的事件可计入第三轮；启动后核对 metrics/History 新事件均为 **0**。
- **启动状态**：旧源码/打包实例已终止；当前 `npm start` 运行 `30a06b0`，使用正常稳定 profile 的既有配置，经产品 recent-project → `openRecentProject` 验证链打开第三副本。界面标题为 **WritCraft-0.1.2-作者验收-3**，当前文件 `edit.md`。
- **作者下一步**：点击左侧 **项目卡**，由作者本人填写并提交；不允许自动化代填项目定义、点击接受/拒绝或替作者给出内容质量判断。

### 0.0BC 2026-07-30 · 独立复审拦截 Safe Undo 时序缺口

- **保留红灯**：对 `6ed6f89` 的新独立复审不是复用旧结论，结果为 **P0=0/P1=2/P2=1**。P1-1：公共进度计时器在 10 秒后固定显示“AI 正在处理”，使 Safe Undo 的“不会调用 AI”再次变假。P1-2：撤销 `finally` 没有 owner token，A 项目的迟到收尾可能停止 B 项目进度、覆盖预览并解锁控件。P2：NO_KEY 只有组件动态测试和 Workspace 字符串断言。
- **生产修复**：进度支持阶段专属准备/长等待文案；Safe Undo 在任意等待时长都只说明本地版本/History 核对。generation progress、Busy 和 undo 引入 owner token；无 owner 的恢复 UI 重算不能覆盖现有 owner，旧 owner 只能清理自己。项目切换和 unload 显式失效旧 owner，普通丢弃和项目卡启动在撤销期间 fail-closed。
- **新增证据**：Renderer dynamic 从 **27/27 → 29/29**，动态跨过 10 秒并走 Workspace 恢复 UI 回调，证明 A 的迟到 `finally` 不清 B 的进度或控件。新增 Onboarding Workspace dynamic **4/4**，覆盖 A→Settings→A 草稿恢复、A→B 不泄漏、成功清理、销毁/项目漂移后的迟到提案只释放不应用。
- **完整验证**：`npm test` exit 0；沙箱 `npm run verify` 在真实 DOM Electron 以 `code=null` 退出，原样在批准 GUI 环境 exit 0；强制真实 Electron 在沙箱因 `listen EPERM 127.0.0.1` 失败，批准 GUI 环境 **37/37**。npm Preview **10/10**；installed 烟测沙箱保留 `PROCESS_SNAPSHOT_FAILED` 红灯，批准环境本机与 Node 22/npm 10 arm64、Node 24/npm 11 x64 均 **2/2**；联网生产依赖审计 **0 vulnerabilities**。
- **门禁结论**：`6ed6f89` 已失效；新 exact candidate 为 **`30a06b0`**。第二轮独立复审逐项重查全部九文件差异与真实回调路径，结论 **P0=0/P1=0/P2=1（仅提交内文档时态）**，允许在本次 docs-only 收口后创建第三个 fresh 副本。

### 0.0BB 2026-07-30 · 项目卡 NO_KEY 可操作恢复与草稿保留

- **现场缺口来源**：0.0AW 已证明隔离 App profile 不继承稳定 profile 的 Key，Main 在 0–24 ms 内返回稳定 `NO_KEY` 且零 provider/零写入；旧 Renderer 却把它折叠成“AI 暂时没有完成整理”，主按钮继续显示“重新整理 edit.md”，导致无效重试。
- **产品修复**：项目卡现在明确显示“这次没有调用 AI”“当前 App 尚未配置 MiniMax Key”“项目文件没有变化”；主按钮改为 **“打开设置”**。设置跳转使用既有 Settings 界面，不读取、复制或迁移 Key。
- **草稿连续性**：项目卡通过既有 `onSessionChange` 把无内容泄漏的本地 session 绑定到 exact project instance；点击“打开设置”前再次保存 session，关闭项目卡后打开设置。配置完成并重新打开项目卡时恢复答案；成功完成或切换项目会清除草稿，避免 A 项目答案进入 B。
- **验证证据**：项目卡 UI **12/12**、Onboarding Renderer dynamic **27/27**（动态证明 `NO_KEY` 文案、设置动作与答案保留）、Main/Preload **14/14**、Workspace **22/22**；完整 `npm test` exit 0、批准 GUI 环境完整 `npm run verify` exit 0、强制真实 Electron **37/37**。npm Preview **10/10**、本机 installed **2/2**、官方 Node 22.22.3/npm 10.9.8 arm64 **2/2**、Node 24.18.0/npm 11.16.0 x64 **2/2**，联网生产依赖审计 **0 vulnerabilities**。dry-run 包为 **120 files / 574,171 bytes / 2,628,827 unpacked / shasum `613a963b9ab2b18c746341448bcb9b4c3f9aab1e`**。
- **候选/下一步**：`89658f0` 因本次生产 Renderer/Workspace 变化失效；修复已提交为 exact candidate **`6ed6f89`**，fresh-tarball 矩阵已关闭。下一道门禁是独立复审；若 P0/P1 为零，再从同一未变验收源创建第三个 fresh 副本，五段作者旅程从项目卡重新开始。

### 0.0BA 2026-07-30 · 精确 Safe Undo 通过并关闭伪 AI 长等待

- **作者动作与磁盘事实**：所有者只撤销 0.0AZ 的最新正文记录。History `change_15c0d56c…` 从 `application/applied` 变为 `application/undone`，`undoneAt` 为 `2026-07-30T09:22:36.421Z`；正文 SHA-256 从 after revision `6e66382…` 精确恢复到 before revision **`1bdb3a5…`**，`edit.md` 仍为 **`e9bacec…`**。因此撤销的目标、持久化事务和项目 Prompt 隔离均通过。
- **保留红灯**：撤销完成后 Changes 预览区仍显示“正在生成跨文件修改”，假计时从 30 秒持续到至少 **159 秒**。没有新 ChangeSet、指标、History 或 Markdown 写入。代码审计定位到 `undoHistory()` 错误调用通用 `startGenerationProgress()` 时使用跨文件 AI 文案，并在成功 `finally` 中只 `setBusy(false)`、没有 `stopGenerationProgress()`；这不是 provider 慢、跨文件请求或用户误触。
- **生产修复**：撤销进度改为“正在安全撤销”，说明正在核对记录/磁盘/History 且**不会调用 AI**；所有撤销终态都停止计时并清除 `generationState`，成功时替换为“安全撤销已结束”的终态卡。错误终态继续沿用既有 fail-closed 错误卡，不被成功文案覆盖。
- **验证证据**：变更 JavaScript 语法检查通过；Changes Review UX **8/8**；完整 `npm test` exit 0；沙箱真实 Electron 因 `listen EPERM 127.0.0.1` 未启动，按环境故障保留；同一命令在批准的真实 GUI 环境 **37/37** 通过，并动态断言撤销后 `generationState` 为空、终态可见且不存在“正在生成跨文件修改”。沙箱 `npm run verify` 又在真实 DOM Electron 以 `code=null` 退出；原样在批准 GUI 环境重跑 exit 0，故分类为环境限制而非产品失败。
- **候选/验收边界**：`9a05c44` 因本次生产 Renderer 变化失效；修复已提交为 exact intermediate candidate **`89658f0`**。第二个 fresh 副本证明了撤销事务与本缺陷，但不能替代最终 candidate 的作者签字。下一步先关闭 0.0AW 的项目卡 `NO_KEY` 可操作提示 P1，再完成全链验证/复审并从同一未变验收源创建第三个 fresh 副本；不得直接从 Chapter/Plan 接着累计为发布证据。

### 0.0AZ 2026-07-30 · 第二个 fresh 副本的真实作者 Inline 接受通过

- **作者动作**：所有者在原有正文 `chapters/01-cope-origin/chapter-01-why-cope.md` 中发起新的独立 Inline Rewrite，并明确反馈“已接受”。自动化没有选择文字、输入指令、生成或点击接受。
- **指标与事务**：operation `b50df12b…` 记录 **6,222 ms `generated` → 2,056 ms `accepted`**，选择内容由 34 字变为 32 字。History 从 4 条增为 **5** 条；最新条目为该精确正文的 `application/applied`，应用时间 `2026-07-30T09:15:10.373Z`。
- **磁盘证明**：最新 History 的 before/after revision 为 `1bdb3a5… → 6e66382…`；目标正文当前 SHA-256 为 **`6e66382…`**，与 after revision 精确一致。`edit.md` 仍为 **`e9bacec…`**，未受段落应用影响。
- **防误操作界面**：修改历史已展开；第一条精确显示 `chapters/01-cope-origin/chapter-01-why-cope.md`、`最新 · 已应用`，其撤销按钮 aria-label 也带完整目标。下一条才是 `项目 Prompt · edit.md`，不得点击。
- **下一步唯一动作**：作者只点击第一条“最新”正文记录的撤销按钮，并在确认框再次核对同一路径后确认。完成前不发起其他写入、项目卡、Chapter 或 Plan；撤销后需证明 History 变为 undone、正文恢复 `1bdb3a5…`、`edit.md` 保持 `e9bacec…`。

### 0.0AY 2026-07-30 · 第二个 fresh 副本的真实作者 Inline 拒绝通过

- **作者动作**：所有者在 `chapters/` 下的普通 Markdown 中选择 11 个字符，发起独立 Inline Rewrite 并明确反馈“已拒绝”。自动化没有选择文字、输入指令、触发生成或点击拒绝。
- **指标证据**：operation `19ea9818…` 记录 **5,431 ms `generated` → 4,911 ms `rejected`**；拒绝事件 before/after 均为 11 字符。界面终态显示“原文已恢复”和“已保存”，不再残留待决 Diff。
- **零写入证明**：从该 operation 的 `generated` 时间 `2026-07-30T09:09:00.342Z` 起，全项目 `.md/.markdown` **零 mtime 变化**；目标文件 mtime 仍停留在项目卡创建初始文件的时点。History 保持 **4** 条，0.0AX 项目卡应用之后新增 **0** 条，不存在 Inline application/review/undo。
- **结论与下一步**：当前 fresh 副本的 Inline 拒绝子步骤通过。下一步必须使用新的 operation 在普通正文生成另一个预览并明确接受；接受后先核验磁盘/History，再只撤销标记为“最新”且精确指向该正文的记录，禁止操作 `edit.md`。

### 0.0AX 2026-07-30 · 第二个 fresh 副本的真实作者项目卡通过

- **作者动作**：所有者在正常已配置 profile 中重新填写并完成项目卡，明确反馈“项目卡已完成”。自动化没有代填答案、选择 Diff、接受审阅或确认初始文件。
- **模型过程**：fresh 副本时间线中，切换正常 profile 后先出现一次 **38,386 ms `structured_failed`**；作者随后重试，同一成功 operation 记录 **29,008 ms `generated`** 与 **165,431 ms `accepted`**。保留红灯，不用成功重试抹除首次结构化失败。
- **磁盘与 History**：`edit.md` SHA-256 从 fresh 基线 `e9e9f7c…` 变为 **`e9bacec…`**；最新 fresh History 为 `edit.md / application / applied`，其 before/after revision 分别与基线和当前磁盘哈希精确一致，应用时间 `2026-07-30T06:52:17.706Z`。
- **初始文件**：第二阶段界面与磁盘均确认创建 **9** 个 `chapters/00-orientation/*.md` 文件；状态显示“已确认并创建 9 个初始文件”。这批文件不替代原有 12 章，只是作者明确确认的项目初始化辅助文件。
- **结论与下一步**：第二个 fresh 副本的项目卡子旅程通过。下一步必须在普通正文完成一次 Inline 预览后明确拒绝，证明正文/History 零写入；再用另一独立 operation 明确接受并从标记为“最新”的精确正文记录执行 Safe Undo。不得撤销 `edit.md` 项目 Prompt 记录。

### 0.0AW 2026-07-30 · 作者项目卡 pre-provider 红灯与配置环境纠正

- **现场现象**：作者在 fresh 副本点击“生成 edit.md 提案”后只看到通用失败提示。以副本 manifest `createdAt` 为切点，私有 metrics 共记录 13 个 Onboarding 事件；失败尝试均为 **0–24 ms**，并伴随即时 retry 事件，没有任何模型级等待。
- **根因与排除**：验收启动使用了全新的 npm Preview `--profile`；该 profile 按隔离合同不继承稳定 WritCraft profile 的 `ai-config.json`。Main 因此在远端调用前返回 `NO_KEY`。稳定 profile 的配置文件只核验存在性，没有读取、复制、输出或重新保存 Key。该红灯不是 provider 失败、AI JSON 错误、内容质量问题或写盘事务错误。
- **磁盘边界**：失败期间 fresh 副本的 Markdown 与 History 没有新增；本页回答只存在于已关闭的隔离 Renderer 会话，不能冒充持久保存或迁移证据。隔离 App 已停止。
- **恢复入口**：已通过产品自身 recent-project 记录让正常稳定 profile 打开同一 fresh 副本；当前界面已确认在项目卡 **1/10 · 内容主旨**，输入框可用。作者需重新填写答案后再次生成，自动化不得代填或替作者作审阅决定。
- **产品缺口**：Main 已保留稳定错误码 `NO_KEY`，但项目卡 Renderer 仍把它折叠为“AI 暂时没有完成整理”。这会诱导无效重试，记录为当前 0.1.2 的可操作错误提示缺口；在改动生产代码前必须先完成或明确重置当前候选/作者证据边界，不能为了改一句文案静默复用受影响旅程。

### 0.0AV 2026-07-30 · 新 candidate 的 fresh 作者副本入口

- **新副本事务**：从作者已确认的验收源创建另一个不覆盖旧红灯证据的隔离副本 `WritCraft-0.1.2-作者验收-2`。事务返回 `copyCreated: true / sourceUnchanged: true`；源 digest 仍为 `9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`。
- **资格**：fresh 副本仍为 `eligible: true`，`edit.md` valid、12 个章节、4748 个可见中文字符、1 个来源文件、20 个项目文件、608,433 bytes。
- **App 入口**：先关闭旧源码/打包实例，再通过 npm Preview 的私有隔离 profile 启动 `9a05c44`。macOS 文件选择器中文辅助输入不可靠，因此改用产品自身 `saveRecentProject` 接口登记同一已授权目录，由 Main 的 `openRecentProject → openProjectRoot` 正常验证链打开；没有绕过项目服务或修改稿件。
- **当前界面与边界**：标题精确显示新副本名，项目卡已打开在 `1 / 10 · 内容主旨`。自动化没有填写答案、点击继续、提交项目卡或触发真实 AI；此时新旅程费用为 0。下一动作必须由作者亲自完成项目卡。

### 0.0AU 2026-07-30 · History 误撤销红灯与防误操作修复

- **真实红灯**：作者按“Safe Undo”提示操作后，磁盘与 History 证明被撤销的是较早的 `edit.md` 项目卡记录；最新章节 Inline 记录仍为 `application/applied`。`edit.md` 从已接受 hash `c678a336…` 恢复到原始 `e9e9f7c…`，章节仍为接受后 hash `81e80023…`。因此 Safe Undo 未通过，旧验收副本已失去当前项目 Prompt，禁止把它修补后继续签字。
- **根因**：History 列表虽然按时间倒序，但每张卡只显示通用文件数量，所有按钮都叫“安全撤销”，确认框也只说文件数；界面没有标出最新记录、精确目标，也没有对非最新记录或 `edit.md` 的项目级影响警告。用户无法在不可逆动作前建立正确心智模型。
- **生产修复**：单文件卡直接显示精确相对路径；`edit.md` 明示为“项目 Prompt · edit.md”；最新卡显示 `最新` 并强化边框；按钮改为“撤销此记录”且 aria-label 带目标。撤销较早记录时明确警告“不是最新修改记录”，涉及 `edit.md` 时额外说明会改变后续 AI 项目上下文；确认清单有界并清除控制字符，避免伪造提示行。
- **当前验证**：纯逻辑 **5/5**、Changes UX **8/8**、完整 `npm test` 与 `npm run verify` 均 exit 0、生产依赖 **0 vulnerabilities**；强制真实 Electron **37/37** 动态证明最新标记、精确章节路径、旧 `edit.md` aria-label/双重确认以及最新记录正常撤销。本机、Node 22/npm 10 arm64 与 Node 24/npm 11 x64 的 fresh-tarball 安装均 **2/2**；包为 **120 files / 573,745 bytes / 2,626,999 unpacked / shasum `4e41acaa8803efdbc093bb4ea72140d1b34fc768`**。三次早期 E2E 红灯均来自新增断言的选择器/精确措辞校准，未改磁盘事务，红运行保留。
- **候选与验收边界**：生产修复及同批测试/合同/状态已提交为新 exact candidate `9a05c44 fix(history): prevent wrong-target undo`；故 `45b1815` 和旧副本的受影响作者证据全部失效。下一步从已确认源创建另一个不覆盖旧证据的 fresh 副本；项目卡与 Inline 三步必须重跑。旧副本只用于复盘，禁止自动恢复、删除或继续累计为最终样本。

### 0.0AT 2026-07-30 · 真实作者 Inline 接受写盘通过

- **作者动作**：所有者在 fresh 正式副本重新发起段落级 Inline，并明确回复“已接受”；自动化没有替作者选择文本、输入指令或接受建议。
- **指标与事务**：该独立 operation 记录 `generated → accepted`；生成 3,906 ms、人工接受决定 2,712 ms，字符计数从 11 到 135。fresh History 新增 1 条目标正文的 `application/applied`，没有污染 `edit.md` 或其他文件。
- **磁盘证明**：History 绑定的 before revision/hash 为 `c73db7c1…`，after revision/hash 为 `81e80023…`；目标正文当前磁盘 SHA-256 为 `81e80023…`，与 afterHash 精确一致。接受因此满足“人工决定后才落盘、磁盘与 History 同步”的契约。
- **后续结果（已由 0.0AU 覆盖）**：作者尝试 Safe Undo 时因旧 UI 目标表达不足，误撤销较早的 `edit.md` 记录；本节只保留为旧候选上的历史 accepted 证据，不再是当前可续作入口。

### 0.0AS 2026-07-30 · 真实作者 Inline 拒绝零写入通过

- **作者动作**：所有者在 fresh 正式副本的正文中亲自完成段落级 Inline 预览并明确回复“已拒绝”；自动化没有替作者选择文本、输入指令或作接受/拒绝判断。
- **指标事实**：副本创建时间之后共有两个独立 Inline operation。第一条只记录 `generated`（5,275 ms），没有决定事件；第二条记录 `generated → rejected`（生成 6,547 ms，拒绝决定 1,887 ms）。不得把第一条未决预览合并或误报为第二次拒绝。
- **零写入证明**：从第一次 Inline `generated` 的时间开始，项目内 Markdown 文件 mtime 零变化；副本创建后的 History 仍只有 0.0AR 的 `edit.md application/applied`，没有 Inline application、review 或 undo 记录。拒绝因此满足“可预览、零正文写入、零可撤销应用”的契约。
- **下一步**：在正文重新发起一次 Inline，明确接受并验证磁盘/History；随后从修改历史执行 Safe Undo，证明正文恢复。该组三步全部完成后，才能把 Inline 子旅程签字并进入 Chapter/Plan。

### 0.0AR 2026-07-30 · 真实作者项目卡旅程通过

- **作者侧签字**：所有者在 exact candidate `45b1815` 的 fresh 正式副本内亲自完成项目卡，接受 `edit.md` 审阅决定，并在独立第二阶段确认创建初始文件；其明确反馈“功能没有问题，已完成操作”。自动化没有代替作者填写答案、选择 Diff 或作质量判断。
- **磁盘与 History 证明**：源原稿 `edit.md` SHA-256 为 `e9e9f7c2…`，正式副本现为 `c678a336…`，证明修改不是只停留在右侧 UI。副本创建后新增 1 条 `application/applied` History，目标仅为 `edit.md`，接受 3 个 hunk、拒绝 0 个；随后新增 **10** 个可见 Markdown 文件。当前副本预检仍 `eligible: true`，为 22 章、4834 个可见中文字符、1 个来源文件、31 个项目文件、625,121 bytes。
- **本次私有指标**：正式副本继承了验收源既有 `.writcraft` 历史，累计值不能冒充本次样本。以私有 author-copy manifest 的 `createdAt` 为唯一切点，本次 Onboarding 仅计生成 **1**、接受 **1**、失败 **0**、结构化失败 **0**、重试 **0**；模型生成 22,171 ms，作者审阅至接受 32,354 ms。样本量为 1，只证明本次旅程，不外推稳定接受率。
- **原稿边界校正**：被确认的验收源全树 digest 继续保持 `9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`。最初作者项目的可见作者文件仍与整理源 **16/16 字节一致**，但其私有 `.writcraft` 元数据后来发生过正常写入，当前全树 digest 已不是 0.0AP 记录的历史值；因此后续不再用该旧全树 digest 声称“最初项目全树未变”，只以确认后的验收源作为正式 source authority。
- **下一步**：第一段“项目卡 → `edit.md` → 初始文件”已通过；五段总门禁尚未完成。下一段由作者在正文中依次完成 Inline 拒绝、Inline 接受、Safe Undo，再继续 Chapter/Plan。`image-01` 最高 20 元授权尚未使用，发布仍未授权。

### 0.0AQ 2026-07-30 · 正式作者隔离副本与旅程入口

- **作者确认**：所有者已明确确认 0.0AP 的合格整理候选为 `0.1.2` 真实作者验收原稿；该确认与先前授权的正式副本父目录、一次最高 20 元的 `image-01` 旅程共同解除 copy gate。
- **正式事务**：仓库内 `acceptance:author:prepare` 的 author-copy transaction 返回 `ok: true`、`copyCreated: true`、`sourceUnchanged: true`；源 snapshot digest 仍为 `9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`。
- **副本当时终态**：fresh 副本预检 `eligible: true`，`edit.md` valid、12 章、4748 个可见中文字符、1 个来源文件；私有验收清单使副本为 21 个文件、608,701 bytes，digest `bfddbe445eb1d96dd5fe322949cf5df0d344eaa2515d441594634b286e4dc1c5`。整理原稿 digest 当时不变；最初项目全树 digest 的后续校正见 0.0AR。
- **当时 App 入口**：源码与 `45b1815` 的生产文件无差异。笔触已明确恢复到 fresh 副本，界面显示 `chapters/`、`references/` 和副本内 `edit.md`，并停在“项目卡 1/10 · 内容主旨”。后续项目卡完成事实见 0.0AR。
- **当时付费与旅程边界**：截至副本刚启动时尚未触发新 AI/付费调用，费用为 0；后续项目卡真实文本调用与当前剩余门禁见 0.0AR，正式发布仍需另行授权。

### 0.0AP 2026-07-30 · 合格真实作者整理候选（待作者确认）

- **授权边界**：所有者明确授权制作整理候选、指定正式隔离副本父目录，并授权一次最高 20 元的 `image-01` 真实付费验收；该授权不包含 npm/GitHub 发布。
- **只做路径整理**：候选保留原项目全部 20 个文件，只将既有稿件目录映射为合同要求的 `chapters/`，并将唯一根级来源文件映射为 `references/`；逐文件 SHA-256 对比为 **20/20 字节一致、0 mismatch、0 extra**，没有改写 Markdown。
- **原项目当时证据**：整理事务前后只读预检 digest 均为 `74beb7755729173272b59500b0707a2488830d2a8c8ea128f0f996bc7d9403a1`，证明该事务没有改动原项目；后续私有 `.writcraft` 元数据变化使该全树 digest 只可作为 0.0AP 的历史快照，当前边界见 0.0AR。
- **候选资格**：新候选预检 `eligible: true`，`edit.md` valid、**12** 个章节、**4748** 个可见中文字符、**1** 个来源文件、20 个项目文件、608,433 bytes，snapshot digest `9d0898863636da74615481a669c3e40362a60176249870e6d1793380c85b4380`。
- **当时下一门禁（已由 0.0AQ/0.0AR 执行）**：候选只是准备结果；作者确认、正式副本和项目卡第一段后来均已完成。当前只按 0.0AR 顶部状态续作。

### 0.0AO 2026-07-30 · 0.1.2 exact candidate `45b1815`（已独立复审并推送）

- **版本边界**：只把 `package.json` 与 `npm-shrinkwrap.json` 根版本从已发布 0.1.1 推进到未发布 0.1.2；没有增加 0.2.0+ 功能、打标签、执行 `npm publish`、创建 GitHub Release 或移动 `latest`。
- **合同顺序修正**：真实作者合同原先一处同时要求“最终旅程绑定既有 exact candidate”和“旅程后才签 candidate”，形成流程循环；现按 `ROADMAP.md` §10 明确为先提交 candidate、再在新合格副本跑最终旅程、最后对同一候选证据签字并申请单独发布授权。
- **定向与完整自动化**：Author copy **48/48**、离线真实 API 合同 **16/16（0 网络）**、Consistency **22/22**、Graph Index **17/17**、Graph correction integration **6/6**、npm Preview **10/10**；完整 `npm test` exit 0。沙箱 `npm run verify` 仅在真实 DOM Electron 以 `code=null` 退出，获准 GUI 上下文原样重跑 exit 0；该红灯保留为环境边界。
- **真实应用与安装矩阵**：强制真实 Electron **37/37**（Plan 写入 206 ms、Graph 撤销 172 ms）、Persistent Main/IPC **3/3**；默认本机、官方 Node 22.22.3/npm 10.9.8 arm64、官方 Node 24.18.0/npm 11.16.0 x64 的新 tarball 隔离安装均 **2/2**。生产依赖联网审计为 **0 vulnerabilities**。
- **包体**：随包 README 对公开 0.1.1 与未发布 0.1.2 证据完成区分后，`npm pack --dry-run --json` 为 **119 files / 572,607 bytes packed / 2,623,581 bytes unpacked / shasum `ae4fb9b1a551a71214e0e4e36aebd100f9acd3b8`**；包内版本与 shrinkwrap 一致为 0.1.2。
- **独立复审、Git 与记忆**：包/Graph 安全边界与文档一致性两路最终只读复审均为 **P0=0/P1=0/P2=0**。7 个候选文件已提交为 `45b1815 chore(release): prepare 0.1.2 candidate` 并推送；该提交是后续新合格隔离副本五段旅程必须绑定的 exact candidate。Nowledge 权威记忆 `e435dd78-2352-46fa-8299-2da2507d0361` 已原位更新并用 `45b1815`、候选 shasum 和作者门禁反查命中。后续纯文档收尾不改变该候选；任何生产源码变化都会使受影响人工证据失效。
- **未完成边界**：本节只证明候选技术准备和 exact commit 已形成。作者显式选择的项目仍不合格，也没有作者指定的隔离副本父目录；不得自行重排原稿或采用未确认项目。五段作者旅程、真实内容无关指标、旅程后独立复审与最终签字仍开放；任何生产源码变化都会要求新 candidate 与新副本重跑受影响旅程。

### 0.0AN 2026-07-30 · Graph Unicode 路径与自动恢复（已独立签字）

- **现场根因**：在用户此前显式指定项目的诊断副本中稳定复现 `INVALID_CACHE`。项目内一个合法 Markdown 文件名含全角冒号 `U+FF1A`；Consistency Engine 错把文件路径当正文执行 NFKC，改写为 ASCII 冒号，随后 Graph Index 的精确证据路径校验正确拒绝该贡献。fresh build 在写缓存前失败，因此这不是“坏缓存需要用户删除”，而是权威路径被分析器改写。
- **两个 P1 的修复**：路径与文本归一化已分离，Graph 证据保留项目服务给出的精确相对路径；`GraphIndexError` 进入 Main 的有界稳定错误映射，不再统一误报“文件系统操作失败”。旧/坏/过大索引自动从权威 Markdown 重建，成功时显示“已安全重建、正文未受影响”；失败时明确正文未改变并提供现有“重新分析”动作，不暴露 `INVALID_CACHE` 或要求手工清缓存。
- **红绿证据**：新增全角路径回归先稳定红于 `缓存证据路径无效`。首轮独立复审发现路径仍会改写 public contract 外输入、Main 原样信任 Graph message、超大缓存失败缺少统一终态等 **P1=3/P2=2**；均转为拒绝而非改写、code allowlist + 固定公开文案和补充行为测试。修复后 Graph Index **17/17**、Consistency **22/22**、Graph correction integration **6/6**、Renderer dynamic **17/17**、Workbench **14/14**。同一诊断副本从原现场失败转为成功重建：14 个 Markdown、466 节点、63 条关系、500 条证据、1 个问题；没有删除作者数据。
- **原项目边界**：只读预检 digest 复查一致，原项目仍无 `graph.json` 写入。当前资格为 `edit.md` 有效、20 个项目文件、608,433 bytes，但合同路径下 `chapters=0`、可见中文字符 `0`、`references=0`，所以未创建验收副本，也不把本次诊断写成五段真实作者签字。
- **完整回归与真实 App**：最终源码完整 `npm test` exit 0；沙箱 `npm run verify` 仅在真实 DOM Electron 以 `code=null` 退出，同一命令在获批 macOS GUI 上下文原样重跑 exit 0。强制真实 Electron **37/37**，并在真实 Main→Renderer Graph 文件筛选中同时看见全角冒号路径及其 NFKC 半角 peer；Persistent Main/IPC **3/3**。全部自动化保持 0 真实付费网络调用。
- **独立复审**：首轮 **P0=0/P1=3/P2=2**，第二轮 **P0=0/P1=0/P2=2**；路径改写、公开错误边界、超大缓存终态、兼容等价双路径/cache roundtrip、测试分母与文档计数全部关闭后，第三轮最终 **P0=0/P1=0/P2=0**。
- **当时门禁（历史，已被 0.0AP–0.0AU 覆盖）**：0.0AN 已提交并推送为 `a72a179 fix(graph): recover unicode author paths`；随后作者已明确选择并确认合格验收源。旧 candidate `45b1815` 又被 0.0AU 失效；当前入口只看本文顶部的新 exact candidate 和 fresh-copy TODO。

### 0.0AM 2026-07-29 · RM-1.0 目标模式路线图冻结

- **权威顺序**：`../docs/ROADMAP.md` 已升级为 `RM-1.0`，成为版本顺序、当前目标、范围/非目标和发版门禁的唯一权威；PRD 继续定义产品契约，本文只记录当前事实和红灯，旧 `deliverables/` 一个月路线图已归档。
- **版本解耦**：路线图使用 `RM-*`，npm/GitHub 产品使用 SemVer，禁止把路线图 `RM-1.0` 当成产品 `1.0.0`。0.1.1 是已发布冻结基线；当前唯一目标为 0.1.2。
- **当前范围**：只完成合格真实作者隔离旅程、`Graph INVALID_CACHE` 根因与产品恢复终态、验收发现的 P0/P1 及私有内容无关指标。驾驶舱、大纲/快速打开、统一 AI 任务中心、`@` 上下文、导出/快照、Pro 与 Team 均按后续版本排队。
- **发版纪律**：0.1.2 必须完成合同、真实作者、完整回归、真实 Electron、独立复审、文档/Git/Nowledge 同步并另获发布授权；不得移动 0.1.1 标签或 npm `latest`。

### 0.0AL 2026-07-29 · 0.1.1 Developer Preview 发版

- **授权与版本**：所有者明确要求更新 npm 版本并创建 GitHub Release；按不改变 Preview 产品边界的补丁版本执行 `0.1.0 → 0.1.1`。`package.json` 与 `npm-shrinkwrap.json` 根版本保持一致。
- **发行内容**：0.1.1 收录 0.0AH–0.0AK 的真实作者反馈修复；面向用户的完整说明见 `../docs/RELEASE-NOTES-v0.1.1.md`。GitHub 使用 `v0.1.1` prerelease，不标记为稳定或 latest。
- **发布前状态**：npm `houxyue` 与 GitHub `MaxHou-infinity` 登录有效；发布前 registry 只有 `0.1.0`，`preview/latest` 均指向它，GitHub 尚无 Release。必须在同一候选上完成完整 test/verify、强制真实 Electron、Persistent、npm Preview、installed、audit 与 tarball 检查，再提交、打标签和发布。
- **候选自动化证据**：完整 Node/安全 `verify` 与 npm Preview **10/10** 通过；local installed **2/2**、官方 Node 22.22.3/npm 10.9.8 arm64 **2/2**、Node 24.18.0/npm 11.16.0 x64 **2/2**、Persistent Main/IPC **3/3**，联网 `npm audit --omit=dev` 为 **0 vulnerabilities**。`npm pack --dry-run --json` 为 **119 files / 571,985 bytes / 2,621,733 unpacked / shasum `d370c500666e25cfb373852deafa21b232d2bc18`**。
- **真实 Electron 红绿记录**：首次 `verify:full` 在完成 selection Chat 后因 CDP `Runtime.evaluate` 单次超时中止；原样复跑 37/37。下一轮又在 Graph Issue History 撤销等待超时，和 0.0AK 既有时序点一致。加入只读诊断、不放宽 15 秒门槛后，同一候选连续两轮 **37/37**，Graph 撤销分别为 **165ms / 172ms**，证明正常产品边界远低于阈值；两次红灯仍保留，不被最终绿灯删除。
- **npm 发布与公网证明**：首轮浏览器通行密钥认证返回页面错误；第二次 Touch ID 完成时 CLI auth token 已过期，`done?authId` 返回 E404。立即只读反查确认 `0.1.1` 仍不存在。使用新 authId 与新 IP 重新认证后，CLI 返回 `+ writ-craft@0.1.1`；registry shasum/integrity 与候选一致，`preview: 0.1.1`、`latest: 0.1.0`，公网隔离安装 **2/2**。
- **GitHub Release**：candidate `c65981e` 与 annotated tag `v0.1.1` 已推送；GitHub Release 使用仓库内用户版说明创建为 prerelease、`latest=false`，未上传本地 ad-hoc App/ZIP。公开地址：`https://github.com/MaxHou-infinity/WritCraft/releases/tag/v0.1.1`。

### 0.0AK 2026-07-29 工作区导航与活动栏 UX 收口

- **现场根因**：文件/搜索由 `workspace.js` 控制，来源和图谱各自监听活动栏点击并维护自己的 `active` / `graph-active`。从来源切回图谱时，中间画布已变化，但来源侧栏和多个选中态仍保留，形成“页面没有切回”的混合界面；这不是单个按钮漏绑，而是三个 Renderer 同时拥有导航权。
- **单一所有权**：`workspace.js` 现在是文件、搜索、来源、图谱四个主工作区的唯一路由所有者；其他 Renderer 只暴露 `activate/deactivate` 生命周期。每次切换会原子更新主画布、侧栏可见性、唯一 `.is-active`、唯一 `aria-current` 和工作区事件。图谱作为完整工作区隐藏项目侧栏，“返回写作”和 AI/Changes 打开都会回到明确的文件视图。
- **信息架构与视觉**：活动栏用本地 SVG 取代含义模糊的 Unicode 字符，按项目视图与协作工具分组，并加入键盘焦点、悬停标签和窄屏约束。“新建项目 / 打开项目”移动到项目标题右侧的 `•••` 菜单；点击外部或 Escape 关闭并恢复焦点，欢迎页入口不变。
- **回归设计**：新增 `verify-v0-workspace-navigation.js` **5/5**，并把“来源→图谱→来源→图谱→搜索→文件、唯一激活态、图谱无旧侧栏、项目菜单折叠”加入真实 Electron。首次把该旅程放在冷 Graph 之前，正确导致旧冷构建断言红灯；测试随后移到全部 Graph 契约之后，避免测试前置条件互相污染。
- **完整证据与保留红灯**：Workspace **21/21**、Graph dynamic **15/15**、Sources race **5/5**、`npm test` exit 0、非沙箱 `npm run verify` exit 0、最终精确源码真实 Electron **37/37**、Persistent Main/IPC **3/3**。沙箱 `verify` 的 DOM Electron `code=null` 经非沙箱原样重跑转绿；真实 Electron 另保留一次旧 Plan 等待超时和一次 Graph Issue History 撤销超时，后续同源码分别为 219–341ms 与全链 37/37，不据单次绿灯删除时序事实。
- **作者项目现场复验与独立待诊断项**：提交后在用户显式项目中实际点击“来源→图谱→文件”，三个视图均正确切换，图谱期间旧来源侧栏不存在；这直接关闭本轮导航反馈。该项目的图谱分析同时返回稳定码 `INVALID_CACHE`，界面显示“文件系统操作失败”。Graph 自动化与真实 Electron 合成旅程仍通过，因此它被登记为独立缓存/项目现场诊断项，**本轮不宣称已修复图谱分析**，也不以删除作者缓存或改写项目内容掩盖。
- **当时边界（已由 0.1.1 发布关闭）**：本轮没有修改 Main 文件权限、AI capability、写盘/History 契约或真实作者项目内容，也没有真实 API/付费图片调用。当时公开的 0.1.0 不含本轮修复；这些修复随后已进入 0.1.1。

### 0.0AJ 2026-07-29 Changes 审阅与长等待反馈修复

- **根因**：文件级“全部接受”和修改块“接受”都只更新 Renderer 的审阅选择，底部“提交审阅决定”才调用 Main 写盘；旧界面没有解释这一层级，重复点击已选状态又是无提示幂等操作。单修改文件同时展示两套等价控件，使用户误以为上方按钮应该立即创建文件。
- **三阶段交互**：项目卡说明和底部状态现在明确“选择不等于写入”。单修改文件不再显示重复批量操作；多修改文件才显示“本文件全接受/拒绝”。作出决定后 Diff 自动收起为“已选择接受/拒绝、尚未写入”的摘要，按钮不再常驻制造失败错觉；“修改决定”可重新展开。Graph Issue 的完整决策门禁仍会在每次选择后明确剩余项数。
- **等待与按钮所有权**：普通 Changes 和章节生成开始后会替换旧预览，显示旋转指示、当前真实工作边界和按秒等待时间；错误转为可见终态。章节生成只把章节按钮标成“生成中”，跨文件按钮不再同时显示“处理中”，避免把两个独立动作误读为并发卡死。
- **测试过程**：新增 `verify-v0-changes-review-ux.js` **7/7** 并纳入 test/verify。定向审阅、Onboarding、Workspace、Graph Issue 全绿；旧集成测试曾因锁死“全部接受”文案红灯，已改为验证 `updateFile` 行为。首轮真实 Electron 又因旧“提交 edit.md 审阅决定”就绪断言超时；第二轮通过 19 个旅程后发现 Graph 强制完整决策提示被新局部反馈覆盖，写盘按钮始终 disabled，修正文案优先级后最终 **36/36**。
- **完整证据**：`npm test` exit 0；沙箱 `npm run verify` 在真实 DOM Electron 启动以 `code=null` 退出，同一 DOM 探针非沙箱 **13/13**，随后完整非沙箱 `npm run verify` exit 0；最终强制真实 Electron **36/36**。本批没有真实 API 或付费图片调用。

### 0.0AI 2026-07-29 项目卡入口与第二阶段信息架构修复

- **入口层级**：`项目卡` 不再占用当前文件的顶部工具栏；改为最左活动栏中的“文”图标，标题和 `aria-label` 明确其项目级职责。入口位置常驻，未打开项目或缺少 `edit.md` 时 disabled，打开项目卡时用 `is-active` 与 `aria-pressed` 显示当前状态。
- **第二阶段职责**：通用 Changes 面板在 confirmation 模式下切换为“项目初始化 · 第 2 步”，显示“项目说明已完成 → 是否创建建议文件”的真实两步关系，并隐藏跨文件 compose、修改历史与协作回顾，避免用户误以为仍需继续审阅 `edit.md`。
- **操作层级**：底部状态占据独立整行；有建议时“跳过文件创建 / 创建所选文件”等高等宽且使用短动词，勾选说明明确“选择不等于创建”。AI 返回零建议时隐藏创建按钮，只保留“完成项目卡”，仍通过 discard route 释放 exact confirmation token，不制造重复动作。
- **验证证据**：Workspace **21/21**、Onboarding Renderer dynamic **26/26**、项目卡 UI **12/12**，完整 `npm test` exit 0。真实 Electron 首轮因测试仍要求旧 `edit.md` 文案在新零建议页面超时；第二轮 36 个行为阶段全部通过后，固定期望仍为 35 而在最终计数红灯。测试改为新用户契约并把新增长文滚动阶段计入固定总数后，最终完整真实 Electron **36/36**。两条红运行均保留，未修改产品权限或放宽性能阈值。
- **最终回归与界面复核**：Electron-enabled `npm run verify` exit 0。作者项目 App 重新启动后，macOS Accessibility 树确认左栏存在可切换的“打开项目卡”项目级图标、文件顶部只保留 `edit.md` 状态与 AI 入口；实际截图确认项目卡已离开顶部工具栏，长文滚动条仍在。项目卡第二阶段由真实 Electron 自动化验证，不在作者项目中额外发起付费 AI 请求。
- **当时收口结果（已由 0.1.1 发布关闭）**：提交 `175b794` 已推送 GitHub并同步 Nowledge；当时尚未进入 npm 0.1.0，随后已随 0.1.1 发布。

### 0.0AH 2026-07-29 项目卡反馈与中央编辑器滚动修复

- **现场根因**：作者在“写作项目 test”提交项目卡后，Main 记录稳定码 `RESERVED_SUGGESTION_PATH`。模型返回了不允许作为初始文件创建的位置；Main 正确停止并保持磁盘零修改，但旧 Prompt 只写“安全相对路径”，没有逐项列明禁区，Renderer 又直接展示“项目 Prompt / 内部目录 / AI JSON”等工程语言。
- **生成源头修复**：Onboarding v2 模型 Prompt 现在显式禁止 `edit.md` 大小写变体、隐藏路径、`.writcraft/**`、`references/**`、`sources/**`、绝对路径和已有路径，并要求无安全建议时返回空数组。Main 的独立路径校验没有放宽，Prompt 约束只减少无效模型结果，不替代 fail-closed。
- **等待体验**：提交后展示“项目卡已提交 → 整理内容并检查建议 → 进入修改预览”三段真实边界、按秒等待时间和“请勿重复提交”；按钮禁用为“AI 整理中”。未使用定时轮播伪装不可观测的模型内部步骤，`prefers-reduced-motion` 下关闭脉冲动画。
- **失败体验**：受保护/非法/冲突建议统一解释为“AI 的新文件建议包含不适合创建的位置”，明确本次没有修改项目文件、本页填写内容仍保留，并给出“重新整理 edit.md”。不再显示 JSON、内部目录分类、Main 错误码或技术消息；“本页保留”不冒充跨重启持久化。
- **编辑器滚动根因与修复**：`.editor-scroll` 原本虽有 `overflow:auto`，但上层 `.work-area` / `.editor-column` 缺少 `min-height:0` 与受限高度，Grid 的最小内容高度会被长文撑出 `100vh` 后由根页面裁掉。现将高度链锁在 viewport 内，编辑器使用独立 `overflow-y:scroll`、稳定 gutter 与可见 11px 滚动轨道，正文最小高度改为容器 `100%`；顶部文件栏和底部状态栏不随正文滚走。
- **验证证据（该批当时状态）**：UI **12/12**、Onboarding service **22/22**、Renderer dynamic **26/26**、Workspace **20/20**、Persistent Watcher Main/IPC **3/3**、完整 `npm test` exit 0；真实 Electron 项目卡红/绿过程按上条记录保留。新增真实 Electron 160 段长文阶段已连续三次通过，证明独立 `scrollHeight`、500px+ `scrollTop`、8px+ scrollbar gutter、body/document 零滚动与底部状态栏留在 viewport。三次全旅程均在该滚动专项通过后，才分别出现既有 Graph timing 红灯：增量构建 867.5ms > 800ms、筛选 114.8ms/112.1ms > 100ms，以及文件筛选 115.1ms / 搜索 111.7ms > 100ms；因此该批当时源码的 `npm run verify:full` **不是全绿**。这些红灯不得被绿色重试抹除；后续当前总链只看本文顶部当前里程碑，不回滚本次滚动修复，也不为通过测试而放宽门槛。
- **验收边界（分发已由 0.1.1 关闭）**：本轮是显式候选上的现场缺口修复，不把不合格项目写成正式真实作者验收；功能随后已进入 0.1.1，但真实作者验收仍开放。

### 0.0AG 2026-07-29 GitHub 公开仓库上线

- **公开地址**：已创建 [`MaxHou-infinity/WritCraft`](https://github.com/MaxHou-infinity/WritCraft) 公共仓库，默认分支为 `main`；本地 `origin` 使用 HTTPS 并跟踪 `origin/main`。首次公开内容提交为 `ce63eb1`，精确当前 tip 仍以 Git 和同步 Nowledge 反查为准。
- **用户叙事**：根 README 从内部状态长报改为用户产品首页，突出 `edit.md`、项目/文件/段落三级协作、差异审阅、一致性图谱与三分钟启动；新增实际渲染通过的品牌 SVG、完整上手指南和公开路线图。路线图明确未来 Pro/Team 收费方向，但不承诺价格、日期或 Preview 升级权益。
- **权利边界**：新增根 `LICENSE`，与 npm 包内 WritCraft Proprietary Evaluation License 1.0 保持同一授权语义；公开源码可见不等于开源。新增 `CONTRIBUTING.md` 和 `SECURITY.md`，仓库已启用 Issues、主题标签和 GitHub 私密漏洞报告。
- **公开前审计**：当前 Git 跟踪快照未发现 GitHub Token、私钥、发布包或用户写作内容；MiniMax Key 形态仅存在于测试夹具。早期调研文档中的当前绝对工作区路径已改为 `<repository-root>`。历史提交保留工程证据，不应把公开仓库误称为开源授权。
- **本轮验证**：用户文档本地链接检查通过，SVG 通过 XML 校验和 Quick Look 实际渲染，根/npm 许可证镜像校验通过，`git diff --check` 通过；`npm run verify:npm-preview` **10/10、零网络调用**，完整 `npm test` **exit 0**。GitHub API 已反查 `PUBLIC`、默认 `main`、Issues 与私密漏洞报告启用、远端首次 tip `ce63eb1`；匿名访问仓库、README 和品牌 SVG 均为 HTTP 200。
- **下一门禁不变**：GitHub 上线是分发与营销基础设施，不替代真实作者验收。下一产品任务仍是选择满足 `edit.md`、5+ 章、2000+ 可见中文字符及 `references/` 的明确项目并创建隔离副本。

### 0.0AF 2026-07-29 npm 公网发布与隔离验收

- **发布成功**：所有者在 npm 浏览器认证后完成发布；registry 时间为 `2026-07-29T09:21:47.833Z`。`writ-craft@0.1.0` 的公开 shasum `a9cb1c4c02639dda213fec3922a204337a8291f9` 与签字候选一致，`preview: 0.1.0`。
- **公网真实验收**：installed smoke 新增精确 `writ-craft@preview`、成对期望 shasum、官方 registry、pack 零脚本与独立空缓存门禁；从 registry 拉取后，在全新临时 HOME/profile 中完成 tarball 安装、Electron Main/Renderer、Main `did-finish-load` IPC、SIGTERM 转发和无残留子进程，**2/2**。首轮对抗复验发现 install 环境仍继承恶意 registry override，并以 `ENOTCACHED` 红灯退出；第二轮复审又发现 pack 仍可能命中用户共享缓存。现将公网 pack 固定临时空缓存并强制在线，pack/install 两阶段均固定官方 registry；在恶意 registry、共享 cache、offline 与 prefer-offline 覆盖同时注入时仍通过 **2/2**。`.` 伪公网 spec 与缺失 hash 均在 npm 执行前失败；本地候选同一 harness 仍为 **2/2**，未打开稿件。
- **保留红灯**：首次 E403 认证阻断已由浏览器认证恢复。发布后 `npm dist-tag ls` 显示 `preview: 0.1.0` 与 `latest: 0.1.0`；尝试经浏览器认证删除 `latest`，registry 返回 E400。官方 registry 对包对象要求至少一个 `latest`，只有一个公开版本时不能清空。未执行高风险 unpublish，也未发布占位版本。
- **产品边界**：`latest` 与 `preview` 指向完全相同的专有评估 Preview，并不代表稳定版签字。推荐、文档和后续验收继续只使用显式 `@preview`；未来正式稳定版必须使用新版本与独立签字。
- **独立终审**：公网 verifier 与发布/文档一致性两路最终均为 **P0=0/P1=0/P2=0**。审阅推动关闭任意 spec 伪公网、pack/install registry override、共享 npm cache 假公网、旧 E404/里程碑指针和 unpublish/占位边界缺口；未修改 registry。

### 0.0AE 2026-07-29 npm 首次发布尝试（历史：2FA 阻断，随后已恢复）

- **已取得授权**：用户明确授权发布 `writ-craft@0.1.0` 到 npm `preview`。
- **临发布复核**：Git HEAD `4c9bd51`、工作树干净、`npm whoami=houxyue`、包名 E404、生产依赖审计 0 vulnerabilities；dry-run 仍为 119 文件、566,536 bytes packed、2,597,021 bytes unpacked、shasum `a9cb1c4c02639dda213fec3922a204337a8291f9`。
- **保留红灯**：`npm publish --tag preview` 到达 npm registry 后返回 `E403`，要求发布 2FA OTP 或启用 bypass 2FA 的 granular token。紧接着只读查询 `writ-craft@0.1.0` 仍为 E404，证明本次没有创建版本或 dist-tag。
- **恢复结果**：所有者随后通过 npm 浏览器认证完成发布；OTP/token 未发送或记录。本节只保留首次 E403→E404 红灯，当前发布事实以本文顶部当前里程碑为准。

### 0.0AD 2026-07-29 专有评估许可发布候选（已签字）

- **所有者决定**：选择 `WritCraft Proprietary Evaluation License 1.0`；`package.json` 与 shrinkwrap 根均使用 `SEE LICENSE IN LICENSE`。许可允许个人或组织内部授权评估，禁止生产、商业交付、托管服务、转售和对外再分发；npm 依赖继续保留各自包内许可证与声明。
- **账户与名称**：`npm whoami` 实时成功为 `houxyue`；不记录密码、验证码或 token。`writ-craft` 只读查询仍为 E404，该结果不是名称保留，发布前必须再查。
- **首轮独立复审红灯**：许可证复审报告两个 P1——组织内部评估与“不得向另一人提供”存在歧义、测试只搜限制关键词可被反向语义绕过；包复审另报告 shrinkwrap 根许可未被测试锁定、权威状态仍指向旧候选。现已定义组织授权评估者及责任边界，改为完整否定句断言，并逐字校验 tarball 内 LICENSE/manifest/shrinkwrap；本文和合同同步更新。第三方许可清单表述与旧 ENEEDAUTH 也一并关闭。
- **候选证据**：P1 修复后定向 10/10；npm 10/arm64 与 npm 11/x64 各 2/2；最终 `npm test` 与非沙箱 `npm run verify:full` 均 exit 0，真实 Electron 35/35、Persistent 3/3。独立复审已在自动化之后另行完成，未用绿色测试代替签字。
- **最终独立复审**：许可证、npm 包候选和文档一致性三路均为 **P0=0/P1=0/P2=0，可以进入 Git/Nowledge 收口**。文档线曾阻断合同提前签字及写死旧里程碑指针，修复后再次只读确认清零。
- **包体**：当前 dry-run 为 119 文件、566,536 bytes packed、2,597,021 bytes unpacked、shasum `a9cb1c4c02639dda213fec3922a204337a8291f9`。任何后续修改都会使该哈希失效。
- **0.0AD 当时的收口与剩余边界（已被后续发布取代）**：候选提交 `3390a86`；Nowledge 权威记忆 `e435dd78-2352-46fa-8299-2da2507d0361` 已更新并反查。当时合同禁止主动发布 `latest`；后续发布记录了 npm 首包对象强制生成同版本 alias 的外部约束。

### 0.0AC 2026-07-29 npm Developer Preview 与 Coding Plan 图片能力（本地候选已签字）

- **用户结果**：可通过 npm 包中的 `writcraft` 命令启动笔触；`--help`、`--version` 和 `--check` 不启动 Electron、不联网。首次真实启动仅在缺失时取得官方 Electron 运行时。
- **包边界**：发布白名单只含 CLI、生产 Main/Renderer、三个 universal helper、README、rights-reserved LICENSE、THIRD_PARTY_NOTICES、manifest 和 shrinkwrap；排除 tests、fixtures、release、状态文档、`.env` 与用户数据。Node `>=22.12.0`、npm 10/11、Electron `43.2.0` 均 fail-closed；manifest/universal helper 声明 arm64/x64。2026-07-29 已用官方 Node 22.22.3/npm 10.9.8 arm64 与 Node 24.18.0/npm 11.16.0 x64 关闭发布前 installed Renderer 矩阵。
- **启动与配置边界**：公开 CLI 等待 Main 在 `did-finish-load` 后发出的 exact IPC，并转发 SIGINT/SIGTERM/SIGHUP；该信号证明页面 load 完成，不单独证明全部 workspace/bootstrap 成功，完整应用行为仍由 35/35 真实 Electron 覆盖。测试证明早期失败和正常退出都会清理整个子进程组。`--profile` 必须位于 HOME 内，CLI/Main 双重验证 canonical 祖先、uid、POSIX mode 与 macOS allow ACL；同 UID 已运行进程属于明确接受的账户内残余。
- **图片能力纠错**：生产端点改为中国站 `api.minimaxi.com`；本地不再把 `sk-cp-` 判为图片不可用。`sk-cp-`/`sk-api-` 都进入真实 provider 门禁，2056 明确解释为套餐资源/每日额度限制。
- **真实门禁**：用户已保存的 Coding Plan Key 用合成提示词成功调用一次 `image-01`，得到 1280×720 JPEG，19,333 ms，269,177 bytes；生成物在验收清理阶段删除，未插入正文。这只关闭“能否调用/解码”的门禁，不关闭作者质量评分、采纳、费用或限流样本。
- **作者项目预检**：显式候选只读预检失败：无 `edit.md`、0 个 `chapters/` 文件、0 个按合同统计的可见中文字符、无 `references/`。源目录未修改，也未创建隔离副本。
- **验证**：npm Preview **10/10**、既有 installed **2/2**、新增 npm 10/arm64 **2/2** 与 npm 11/x64 **2/2**、Graph dynamic **15/15**、Persistent **3/3**、最终 `npm test` 与非沙箱 `npm run verify` exit 0；Graph dynamic 明确锁定 persist→Main watcher barrier→build，并证明 barrier 失败时 build 零调用。真实 Electron 在一次 101 ms 性能红灯后，同一源码连续两轮 **35/35**。2026-07-29 联网 `npm audit --omit=dev` 仍为 0 vulnerabilities，tarball 哈希保持 `ceca163826dc95c292d509092421e4cb07c653af`。沙箱内 installed harness 因进程快照权限返回 `PROCESS_SNAPSHOT_FAILED`，完全相同命令在获准非沙箱 GUI/进程环境通过 2/2；x64 首轮另因测试 PATH 缺 `/usr/sbin` 返回 `sysctl: command not found`，只补回标准系统 PATH 后同源码通过，均按环境边界保留红/绿证据。
- **独立复审**：首轮代码/包复审发现文件 mode、profile 祖先/ACL、CLI 信号、Renderer readiness 四项 P1，合同复审另发现 npm 10/11 fail-closed、audit 与文档/清理缺口；全部转为生产边界和回归。最终代码、发布合同和文档一致性三路独立复审均为 **P0=0/P1=0/P2=0，可以完成本地候选签字**。
- **当时开放门禁（已部分由 0.0AD 关闭）**：0.0AC 签字时终端未登录、许可证未选择；0.0AD 已验证账户并落地专有评估许可。名称仍未保留、显式 publish 授权未取得、preview tag 未发布，真实作者项目也不合格。不得把本段写成公开发布或 V0 可用性验收完成。

### 0.0AB 2026-07-28 普通 Markdown 项目回收区

- **用户结果**：Explorer 新增可展开“项目回收区”，展示原相对路径、删除时间和大小，支持刷新与单项恢复。恢复成功后刷新权威文件树和列表，不自动打开文件，也不改变 Changes/History。
- **Main/Renderer 权威**：Renderer 只提交项目实例与 opaque token；列表先跨 watcher strict flush barrier，再绑定 exact project/root/navigation/mutation/owner。刷新和恢复共享 single-flight，迟到 A→B 响应不能覆盖当前项目。所有写路径受同根 exact-owner mutation lease 与 unresolved journal 恢复锁保护。
- **native 事务**：第三个 universal helper 从 Main 传入的可信根 fd 工作，路径逐段 `openat(O_NOFOLLOW)`；journal 持久化完整 R/T P/Q/D、M0/M1、source/target parent、文件与自身 identity。正常提交和崩溃恢复在每个 committing rename 前从可信根重走 named ancestor，末次核验内容、inode、manifest 和目标不存在；response-loss 只重建终态，不重复已提交 mutation。
- **红灯与教训**：首轮独立复审的目录换壳、恢复锁绕写、state-lag 与私有目录问题，以及后续 journal 长度/body digest、M1/qmanifest identity 和 recovery final-rewalk 均通过确定性故障测试关闭。容量测试曾以 0755 夹具触发正确的隐私目录拒绝，分类为测试夹具错误后改为 0700；产品合同未放宽。真实 Electron 曾暴露二次列表刷新撤销旧 token 但旧按钮仍可点击，现以 Renderer single-flight/busy owner 关闭。
- **签字证据**：native worker **20/20**、Trash service/handler **11/11**、File Lifecycle **16/16**、Inline Integration **7/7**、Network **15/15**、Reference Import **15/15**、Project Intelligence **17/17**；完整 `npm test`、非沙箱 `npm run verify`、Persistent **3/3**、真实 Electron **35/35**、package **8/8**、release **7/7** 全绿。最终独立复审 **P0=0/P1=0/P2=0**。
- **0.0AB 当时边界（已由 0.0AC 发布路线更新）**：永久清空普通 Markdown 回收区不属于 0.0AB；当时曾把完整 `sk-api-` 图片和 Developer ID 当作发布门禁。0.0AC 已纠正为 provider 现场能力判断与 npm Preview 路线；当前图片/发布事实只看顶部。

### 0.0AA 2026-07-28 Main-owned Chat 最近对话与多轮连续性

- **用户结果**：Chat 能沿用最近最多 6 轮已完成对话；顶部显示“已保留 N 轮”，Context Inspector 只披露实际使用轮数和大小。用户可显式点击“新对话”，项目/内容/导航变化也会建立新上下文。
- **权威与隐私**：历史仅存在 Main 内存，不落盘、不由 Renderer 回传；绑定 owner、navigation epoch、project instance、canonical root 与 mutation generation。用户/助手单轮、摘要、UTF-8、TTL 和 owner 数均有硬上限，不额外发起付费摘要调用。
- **并发与重开**：每次新提交在任何保存、flush 或 Context await 前先通过 trusted `cancelPending` IPC 取消 Main 在途 lease，只保留已完成轮次。只有最新 lease 可提交；同项目显式重开在 tree/`edit.md` 全部读取成功后、安装项目前 abort/invalidate，失败重开零会话副作用。
- **可见体验**：摘要正文不返回 Renderer；实际回复显示不可移除的“最近对话” Chip。普通 context invalidation 保留旧 Inspector 作为历史 provenance，显式新对话才清除。安全中文 message 优先于内部错误码。
- **验证**：Conversation **8/8**、Chat **12/12**、Resolver **26/26**、Inspector **9/9**、Policy **10/10**、Network **15/15**、Workspace **10/10**；完整 test/verify、Persistent **3/3**、package **8/8**、release **7/7**，最终源码真实 Electron 连续两次 **34/34**。
- **独立复审**：三轮逐项关闭 2 个 P1 与 3 个 P2，最终 **P0=0、P1=0、P2=0，可以技术签字**。冻结合同见 `../docs/CHAT-CONVERSATION-V1-CONTRACT.md`。

### 0.0Z 2026-07-28 超长 edit.md 分区上下文与 Inspector 披露

- **用户结果**：Chat/Context 不再因为项目卡整体超过 6000 字符或 18 KiB 就直接失效。Main 在围栏外解析 ATX 标题，优先完整保留“项目主旨、范围与非目标、关键实体与不变量、时间与关系约束”，可选章节按原文顺序整章填充预算。
- **权威与边界**：同一 `edit.md` revision 同时绑定编译内容、项目 Prompt Chip 和每个章节 locator；必需章节自身超限、超长标题和超量目录均稳定 fail-closed。短项目卡仍全文进入，过密目录退化为一个有界“完整 edit.md”披露项。当前只接入 Chat/Context，其他 AI 模式合同未改变。
- **可见体验**：Context Inspector 在固定 `edit.md` 卡内显示每章“已使用/已省略”、原因和大小；点击只有在 nested revision 与父 Chip 完全一致且磁盘 revision 未漂移时才定位，缺失、错配或过期均不猜测新偏移。
- **测试与复审过程**：Resolver **26/26**、Inspector **8/8**、Chat **11/11**、Policy **10/10**；完整 `npm test`/`npm run verify` exit 0、Persistent **3/3**、package **8/8**、release **7/7**。首轮 33/33 后独立复审发现并推动关闭五项对抗缺口；第三轮代码复审 P0/P1/P2=0。最终源码在两次不同旧阶段超时后，不改代码连续两次完整 **33/33**；红运行保留，稳定性 P2 按连续同源证据关闭。
- **最终独立复审**：**P0=0、P1=0、P2=0，可以技术签字。** Scope 明确只覆盖 Chat/Context；其他 AI 模式不得引用本合同冒充已统一。
- **发布边界**：package **8/8**、release **7/7** 只证明 ad-hoc 本地 App/ZIP 与当时源码；正式签名、公证、Gatekeeper、真实 API 与作者验收仍开放，禁止分发。

### 0.0Y 2026-07-28 worker async-close 与构造错误脱敏（独立复审签收；历史）

- **红灯**：用受控 `ready()` 和 awaited `beforeHashOpen()` 在 continuation 前关闭 worker；旧实现仍创建 pending 并调用 `stdin.write()`，触发未处理的 `ERR_STREAM_WRITE_AFTER_END`。另以不存在的私有根和注入式 `lstat` 故障证明原始文件系统异常会携带绝对路径。
- **修复**：私有 `#assertOpen()` 在入口、`await ready()` 后、每个 awaited hook 后及最终写入前检查 failed/closed/closing/child/stdin 状态。最后一次检查到 pending+write 之间没有 `await`，不会被同一 JS 线程的 `close()` 插入。关闭后返回稳定 `PROJECT_WATCHER_HASH_HELPER_UNAVAILABLE`，零 batch write、零 pending。
- **脱敏**：输入格式错误仍为 `PROJECT_WATCHER_HASH_PROTOCOL`；合法绝对根的 `realpathSync/lstatSync` 失败统一映射为无路径 `PROJECT_WATCHER_ROOT_CHANGED`，不携带原始 error/cause。既有 batch-level `ROOT` 恢复语义和终止型 `BUDGET/PROTOCOL` 语义未改。
- **验证**：worker **18/18**、Watcher **31/31**、cross-layer **11/11**、Large **6/6**、完整 `npm test`、非沙箱 `npm run verify:full`、强制真实 Electron **32/32**、Persistent **3/3**、package **8/8**、release **7/7** 全绿。
- **独立复审**：P0=0、P1=0、P2=0。本批两个 P2 均关闭；当前 App/ZIP 仍是 ad-hoc 本地证据，禁止分发。

### 0.0X 2026-07-28 可信根 fd 项目根链绑定（历史；两个复审 P2 已由 0.0Y 关闭）

- **冻结合同**：Main 只在启动前私有捕获 canonical project root `{dev,ino,mode}`，把可信文件系统根 `/` 的只读目录 fd 作为 fd 3；绝对项目路径仅以有界十六进制启动记录进入 helper stdin，禁止进入 Renderer、stdout/stderr、诊断、错误或测试证据。
- **native 权威**：helper 从 fd 3 对绝对路径每个组件执行 `openat(O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)`，私存每级身份与最终项目 fd。启动 ACK 只返回最终根身份；Main 捕获身份不匹配即拒绝启动。
- **批次语义**：每个 hash batch 在读取稿件前和成功终态前重走完整外层根链。任一级替换、symlink 或身份漂移返回 batch-level `ROOT`，丢弃整批 authority；恢复原链后同一 worker 可重试。协议、预算和 helper 故障仍保持终止语义。
- **红灯与回归**：旧实现的绑定前外祖先替换测试稳定为 worker 12/13、`false !== true`。当前 worker **15/15**，覆盖初始 symlink 拒绝、绑定前/后祖先替换、恢复、ROOT 映射、路径零回显和既有 16 MiB 预算；Watcher **31/31** 证明 strict flush 零 payload、明确 blocked state 与恢复后首次有效失效。
- **全链证据**：cross-layer **11/11**、Large **6/6**、完整 `npm test`、沙箱外 Electron-enabled `npm run verify`、Persistent **3/3**、强制真实 Electron **32/32**、package **8/8**、release **7/7** 通过。当前 App/ZIP 仍是 ad-hoc 本地证据，禁止分发。
- **当时独立复审**：P0=0、P1=0、P2=2。async-close 与构造错误路径脱敏两项现已由上方 0.0Y 的确定性红测和生产修复关闭；0.0X 数字仅为历史批次证据。
- **精确范围**：本批关闭身份捕获之后的 initial native bind 与后续 hash 外祖先换壳，不证明文件选择器之前的用户选择，也不使 `readdir/fs.watch`、同 UID 持有 fd 写入或 0.0U reserve residual 原子安全。以上是范围边界，不是应从旧 TODO 重开的 watcher P2。

### 0.0W 2026-07-28 native hash 序列化请求预算（历史；其唯一 watcher P2 已由 0.0X 关闭）

- **红灯**：深 128 级、长路径、宽 identity 的批量输入在 0.0V 只受 5000 文件/64 MiB 内容预算限制，会先构造超过合理边界的 metadata payload。新增回归先因 `MAX_REQUEST_BYTES` 不存在稳定失败。
- **JS 门禁**：`encodeBatch()` 将完整 header、每条 item 与 LF 按 UTF-8 精确增量计数；固定 16 MiB。任何一条会越界时先返回 `PROJECT_WATCHER_HASH_BUDGET`，再加入 `lines`，不会先拼出超大完整 payload。
- **native 门禁**：helper 用同一 16 MiB 上限累计实际读取的 `line_length + 1`，包含 header 与每条 LF；超限输出唯一批次终态 `E <seq> ERR BUDGET`、关闭根 fd 并失败退出。Main 将该终态映射为同一预算错误并终止 worker。
- **验证与复审**：worker **12/12**（含边界内、首条超限、真实 native >16 MiB 输入与终态映射）、Watcher **30/30**、cross-layer **11/11**、Large **6/6**、package **8/8**、release **7/7**；完整 test/verify、Persistent **3/3**、强制真实 Electron **32/32**。独立复审最终 **P0=0/P1=0/P2=1**；metadata 上限 P2 已关闭。
- **当时剩余 P2**：初始 `fs.openSync(rootPath)` 仍解析项目外层祖先；该项现已由 0.0X 的可信根 fd 逐段绑定关闭。0.0W 数字仅为历史批次证据。

### 0.0V 2026-07-28 watcher 祖先逐段 `openat`（历史；metadata P2 已由 0.0W 关闭）

- **已实现**：新增 universal native `project-hash-helper` 与持久 `project-hash-worker`。Main 扫描时私存项目内部每级目录及叶子的完整 BigInt identity；helper 从已绑定的项目根 fd 出发逐段 `openat(O_DIRECTORY|O_NOFOLLOW)`，读前/读后验证叶子，并重新遍历祖先链。普通公开 snapshot 字段保持既有 Number 兼容语义。
- **协议与生命周期加固**：扫描根与 worker 根的 `{dev,ino,mode}` 必须一致；缺失 `O_DIRECTORY/O_NOFOLLOW` 明确返回 unsupported；helper 的 malformed successful identity 被捕获为协议失败，不能从 EventEmitter 回调逃逸并终止 Main。开发态与打包态 helper 路径以 `!process.defaultApp` 明确区分。
- **双-helper发行链**：release schema v4 分别绑定 author-copy 与 project-hash 的 source、signed universal build、App helper 和标准 `unzip` 后 helper；两个 helper均独立验签并执行，完整 App tree 与该批源码一致。
- **验证与复审**：native worker **10/10**、Watcher **30/30**、cross-layer **11/11**、Large **6/6**、package **8/8**、release **7/7**；完整 `npm test`/沙箱外 `npm run verify` exit 0，Persistent **3/3**、强制真实 Electron **32/32**。独立复审最终 **P0=0/P1=0/P2=2**。
- **精确边界**：本批关闭已绑定项目根 fd 以下的祖先替换，不关闭初始根路径打开时其外层祖先竞态。第二个 P2 是当时尚未约束序列化 metadata/payload 总字节；现已由上方 0.0W 的 16 MiB 双侧门禁关闭。目录枚举/watcher 的非原子性及同 UID 已持有 fd 的并发改写继续作为范围说明；身份漂移、helper/预算失败均 fail-closed。

### 0.0U 2026-07-28 native reserve 预所有权副作用加固（独立复审签收）

- **红灯与根因**：测试专用 helper 在 `mkdirat` 后、`openat` 前把原目录移走并放入 0755 空目录。旧实现会先对打开对象执行 `fchmod(0700)`，再把它当成合法 stage；这证明 helper 在尚未建立本次创建所有权时，既修改了外来目录，也会接受可观测异常替身。
- **修复**：`mkdirat` 在临时 `umask(0077)` 下执行并恢复调用方 umask；打开后只读验证 fd/path 的 `dev/ino`、目录类型、低九位 0700、当前 euid 与空目录，验证前不 `fchmod`、不写 receipt、不清理、不发布。目录扫描无论成功或报错都关闭复制 fd；不依赖 APFS 特有的 `st_nlink == 2`，并允许 setgid 父目录继承 supplementary group。
- **覆盖边界**：测试宏只进入临时测试二进制，正式 helper 不包含攻击标记。新增动态回归证明 0755 替身被拒绝且原目录、替身权限与内容均不改变；另证明 shared/setgid 父目录仍可合法 reserve。Author 从 **47/47** 升至 **48/48**。
- **验证与复审**：两种 Clang `-Wall -Wextra -Werror` 通过；Author **48/48**、Offline API **15/15**，合计 **63/63、0 网络**；完整 `npm test`、沙箱外 `npm run verify`、Persistent **3/3**、强制真实 Electron **32/32**、package **8/8**、release **7/7** 均通过。正式 universal helper、App 与 ZIP 已从当前源码重建；仍仅为 ad-hoc 本地证据，禁止分发。独立复审 **P0=0/P1=0/P2=1**。
- **接受的 P2**：同 UID 攻击者若在极窄窗口放入同属当前 euid、低九位 0700、空且路径/fd 一致的目录，事后检查无法证明它不是本次 `mkdirat` 的对象。macOS 11+ 公共 ABI 没有“创建目录并原子返回 fd”的原语；随机名只降低概率，不构成所有权证明。当前威胁模型明确接受此残余；若未来必须关闭，先改变 staging 权限/父目录架构，不能宣称本批已彻底消除。

### 0.0T 2026-07-28 Plan 写入终态时序（历史；reserve 边界已由 0.0U 更新）

- **历史红灯没有被重跑抹掉**：0.0S 首次真实 Electron 在“接受 Plan 任务后写入正文”阶段超过 15 秒。旧诊断只有最终文案等待，不能区分接受、应用、磁盘提交或界面收口。
- **确定性根因类**：Main/Workspace 的 `reconcileChangesHistoryAfterMutation` 已从磁盘读取并安装 tree、当前文件与 History，再精确清除恢复 marker；Changes Renderer 随后又无条件执行第二轮 `refreshTree/reloadCurrent/loadHistory`，使“磁盘与 History 已提交”的终态文案错误依赖一个非权威、无界的重复 IPC 链。故障注入把该重复 refresh 永久挂起，旧实现稳定无法进入终态。
- **修复**：只有 `authoritativeReloaded === true` 时，普通、残余、Research residual-unavailable 与 Onboarding/edit.md 成功分支跳过重复 tree/current/history；当前文件不是 `edit.md` 时仍显式打开它。`false/undefined`、不可信响应和恢复失败继续走旧 fail-closed 刷新/锁定路径。
- **可观测性**：真实 Electron 先单独点击并断言唯一 hunk 已接受、按钮可用，再单独应用。超时诊断仅记录 accept/apply 阶段、耗时、UI 布尔/计数/文本长度及磁盘 bytes/SHA-256，不记录正文、Diff、绝对路径、Prompt 或凭据。
- **验证与复审**：新增普通、Research residual-unavailable、Onboarding 当前非 `edit.md` 三条重复-refresh 挂起回归；Renderer dynamic **25/25**。完整 `npm test`、沙箱外 `npm run verify`、Persistent **3/3** 通过；本地两次和独立复审一次真实 Electron 均 **32/32**，Plan apply 分别约 **205ms、224ms、1078ms**。独立复审最终 **P0=0/P1=0/P2=0**，本轮 timing P2 关闭。
- **当时剩余边界**：0.0T 当时仍列两个本地安全 P2（纯 Node 祖先逐段 `openat`、native `mkdirat→openat/fstat` 微窗口）及外部门禁；native reserve 项后来由 0.0U 关闭可观察副作用并明确接受 residual，祖先项随后由 0.0V 关闭到“已绑定项目根以下”的范围。不能把任一历史批写成完整 V0。

### 0.0S 2026-07-28 reserve receipt / build-attestation（历史；第三轮独立复审签收）

- **reserve 真相与恢复**：Main 创建并持有匿名、`0600`、`O_RDWR` 的 receipt fd 5；helper 在任何 `mkdirat` 前以 `fcntl(F_GETFL)`、类型和权限预检它。stage 身份核验与 parent `fsync` 后，helper 写入并 `fsync` exact `{name,dev,ino,mode}` receipt；stdout/status 丢失时 Main 只从该 receipt 恢复，不公开恢复细节。
- **失败与清理**：stdout 与 receipt 都不可用时 fail-closed，保留未知 stage，绝不猜测删除；readonly receipt 在创建 stage 前拒绝。身份已经由打开 fd 证明后，parent `fsync` 或 receipt 写入失败会按 exact `dev/ino` 重新核验后尝试清理；发现换壳则不 adopt、不删除。`mkdirat→openat/fstat` 身份未知微窗口仍保留为 P2。
- **构建/打包因果**：native build signature 已进入 recipe；attestation 将 C source/build helper 绑定到 App helper，再绑定到 ZIP helper 与完整 App tree（含 symlink 与 POSIX mode）。release 还固定核对产品名、当前 `package.json` 版本、ad-hoc 签名声明与未公证事实，不能靠篡改 build-info 冒充正式发布。当前 package **8/8**、release **7/7**；本轮本地 ad-hoc App/ZIP 均按当前源码重建，仍禁止分发。
- **验证**：Author **47/47**（含真实 helper 的无 receipt、readonly receipt、stdout/status 丢失、双证据丢失与换壳场景）+ Offline API **15/15** = **62/62、0 网络**；`npm test` 与沙箱外 Electron-enabled `npm run verify` exit 0；Persistent **3/3**。本轮首次 Plan write timeout 在状态诊断加入后未复现，连续两次完整真实 Electron **32/32**；首个 timeout 的 timing 根因尚未解释，保留 P2，不能由重跑绿灯关闭。
- **独立复审与当时外部门禁**：第三轮独立复审 **P0=0/P1=0/P2=3，可以技术签字**；三个 P2 是纯 Node 祖先逐段保护、native `mkdirat→openat/fstat` 微窗口和未解释的 Plan-write timing。当时曾把完整 `sk-api-`、Developer ID、公证与 Gatekeeper列为首发门禁；该判断已由 0.0AC 的 provider 现场能力与 npm Preview 路线更新，真实作者和账户证据仍开放。

### 0.0R 2026-07-27 strict watcher fd hash（已签收；历史）

- **目标与结果**：关闭 0.0Q 唯一 P2 的精确范围：扫描 `lstat` 后，最终文件组件被普通文件或 symlink 替换时，旧 `createReadStream(path)` 会重新解析路径、读取更大目标并继续按旧 size 记账。默认生产哈希现只通过 fd 读取，不再 path-based stream。
- **权威身份与预算**：扫描使用 BigInt stat 私存 `dev/ino/size/mode/nlink/mtimeNs/ctimeNs`；打开使用 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`。打开后、读完后均 `fstat`，返回前再次 `lstat(path)`；任何身份、大小或纳秒时间漂移都进入 `hashErrors`。读取按已验证 size 以 64 KiB 分块，绝不读取候选预算外字节，成功和失败均在 `finally` 关闭 fd。
- **兼容与失败语义**：BigInt 身份不进入公开 snapshot；公开 `size` 与旧 `Math.trunc(normalStats.mtimeMs)` 保持 Number 语义。ordinary polling 的瞬态失败继续返回本轮无权威 hash、等待后续轮转；strict flush 因覆盖不完整返回 `PROJECT_WATCHER_FLUSH_INCOMPLETE`，不发布成功失效或 barrier。
- **红灯与纠错**：新增红测先证明旧实现缺少安全 helper/identity；完整套件随后暴露一次 `mtimeMs` 精度兼容红灯。根因是把内部纳秒安全升级错误地直接改变了公开毫秒舍入，而非产品 watcher 逻辑失败。最终实现把“私有精确权威”和“公开兼容字段”分离，并以 50 轮时间边界及最终 10 轮新套件复跑证明稳定。
- **验证**：Watcher **28/28**（含真实 strict flush scan→open symlink fault、零成功 payload、成功/失败 fd close）、跨层 **11/11**、Large **6/6**；完整 `npm test`、沙箱外 Electron-enabled `npm run verify` exit 0；真实 DOM sanitizer **13/13**；同一源码真实 Electron 连续两次 **32/32**；Persistent Watcher Main/IPC **3/3**。
- **独立复审**：最终 **P0=0/P1=0/P2=1，允许签字与提交**。保留 P2 是 `O_NOFOLLOW` 只保护最终组件，纯 Node 无法对祖先目录进行 fd-relative `openat` 逐段遍历；不得把本批写成“全路径 TOCTOU 已消除”。若以后提升到恶意并发祖先替换威胁模型，须用 native helper 单独关闭。
- **历史下一步（已由 0.0S 与 0.0AC 取代）**：当时计划处理 native reserve 空 stage/build 因果并把完整 `sk-api-`、Developer ID、公证列作门禁。reserve 已由 0.0S 收口；发布边界已由 0.0AC 更新为 npm Preview、provider 现场能力、许可证/账户/矩阵与真实作者门禁。

### 0.0Q 2026-07-27 Main-owned Watcher flush（已签收）

- **目标**：删除 Renderer 以 1.5 秒时间稳定推断 watcher 已静默的做法。任何在 own-save 或受控外部写后铸造 AI/Onboarding authority 的路径，都先取得 Main 对当前项目 watcher 的显式 flush 证明。
- **权威顺序**：Main 等待既有 polling → 强制再做一轮项目快照 → 立即发布/清空 debounce pending → 发送只含随机 `flushId`、当前 `projectInstanceId` 与 mutation generation 的 barrier。Preload 必须在 invoke 前监听 exact barrier；Renderer 收到 barrier 后等待 `external-sync-state-service` 的队列 drain，任何刷新失败都持续阻止 AI，直到后续成功同步或项目重开。
- **失败矩阵**：不可信 sender、项目切换、watcher degraded/closed、internal mutation in-flight、扫描/哈希/entry-limit 不完整、barrier 发送失败均 fail-closed；不得返回成功、不得铸造新 authority。并发 flush 在 watcher 内 single-flight，不重复扫描或重复推进 generation。
- **隐私与能力边界**：Renderer 只传当前 project instance ID，不传 root、路径、revision、正文或 flush 结果内容；flush 是只读同步点，可因发现真实外部变化推进既有 Main/Renderer generation，但不得写稿件或吞掉 change。
- **验证要求**：Project Watcher 定向测试覆盖强制快照、debounce drain、single-flight、扫描不完整失败和 close 竞态；Main/preload/Renderer 静态与动态边界覆盖 exact barrier、项目漂移和 listener 清理；真实 Electron Onboarding 不再含时间静默 helper，并至少完成聚焦重复与完整 32 阶段回归。
- **完成结果**：Main handler、IPC、preload listener-before-invoke exact handshake、Renderer barrier 后外部刷新 drain、Chat/Inline 可见失败态和真实 Electron 均已接通；1.5 秒 helper 与旧 `externalQueue` 测试等待已经删除。首次 strict flush 主动发布一次全项目失效，扫描期间 internal-mutation epoch、navigation epoch、项目/watcher 漂移和 Renderer 刷新失败全部 fail-closed。
- **对抗修复**：第一轮独立复审在全量绿灯后发现 3 个 P1：内部写可在扫描期间完整发生并结束、初始 poll 可先吸收外部写、Renderer 会吞掉外部刷新异常。三项均先加红灯再修复。自审另发现普通轮转 hash 预算被误用于“完整”flush，已改为独立 5000 文件/64 MiB 全 Markdown hash，超限失败。
- **真实 Electron 过程证据**：一轮旧测试断言曾把运行时 project instance 与不存在的 fixture 字段比较，产品 barrier 已成功但测试红；修正后聚焦 2/2。最终收口前还保留两次不同阶段的等待超时；加入终态快照并把 Graph 的旧 `externalQueue` 等待替换为 Main barrier 后，当前同一源码连续两次完整 **32/32**。
- **最终签字**：Watcher **23/23**、跨层 **11/11**、Workspace **19/19**、Chat **11/11**、Inline **14/14**、Large **6/6**；完整 `npm test`、Electron-enabled `npm run verify` exit 0，Persistent Watcher **3/3**。独立二审 **P0=0/P1=0/P2=1，可以签字**。该批唯一 P2 是 strict hash 的 `lstat→path createReadStream` 本地并发替换窗口；它已由上方 0.0R 的 no-follow fd、pre/post identity 与有界读取关闭到最终组件范围。

### 0.0P 2026-07-27 原生 helper 与 Onboarding E2E 稳定性收口（历史）

- **原生发布助手**：用仓库内 `native/author-copy-helper.c` 和 universal Mach-O `src/main/native/author-copy-helper` 取代 `/usr/bin/python3 -I` 脚本。服务只执行绝对 bundled helper；helper 继续通过继承 fd 3/4 执行 reserve、inspect 和 `renameatx_np(RENAME_EXCL)` publish，不重新解析父目录路径。
- **干净运行时证据**：helper 为 `arm64 + x86_64`、可执行、ad-hoc linker-signed；Author 在空 `PATH` 下可成功创建精确副本，证明运行时不查找 Python 或外部解释器。构建仍要求开发机具备 Xcode Command Line Tools，但分发后的 App 运行不要求。
- **打包闭环**：`prepackage:mac` 会重建 helper；helper 位于标准 `Contents/Helpers`，先独立 ad-hoc 签名，再签外层 App。App/helper 最低系统版本统一为 macOS 11；build-info 同时绑定 C 源码和 packaged binary SHA-256。ZIP 使用 `ditto --norsrc` 排除 AppleDouble，release 以标准 `unzip` 解压后断言零 `._*`、逐项 strict verify，并对解压 helper 运行真实 fd-relative reserve/publish。package 静态检查 **6/6**、release **7/7**；产物未 Developer ID 签名/公证，继续禁止分发。
- **Onboarding 根因（0.0P 当时的临时修复，已由 0.0Q 取代）**：此前红灯不是业务层漏写，而是测试删除外部冲突文件后只等待第一次 watcher generation 变化，便生成新 capability；轮询 fallback 的迟到事件再次推进 generation，产品按设计把提案判 stale。0.0P 曾用 `externalQueue` 加 1.5 秒稳定窗观察；0.0Q 已删除该推断并改为 Main exact barrier。
- **0.0P 稳定性证据（历史）**：Onboarding 聚焦真实 Electron连续 **6 次 2/2**，E2E fatal 加固后再过 **2 次 2/2**，随后完整真实 Electron **32/32**；timeout 分支保留可读 Renderer 状态快照。Harness 从 spawn 起统一清理，进程 exit 与 CDP failure 均进入全局 fatal latch，每阶段及绿线前复核，并强制固定 2/32 计数。
- **0.0P 当时回归（历史）**：Author **42/42** + API Offline **15/15** = **57/57、0 网络**；`npm test`、Electron-enabled `npm run verify` 均 exit 0；package **6/6**、release **7/7**、最终强制 Electron **32/32**。0.0AB 后续曾推进到 35/35，当前总链只看本文顶部当前里程碑。
- **复审纠错**：第一轮增量复审在全部绿灯后仍找出 4 个 P1：helper 未独立签名、App/helper minOS 断层、最后 CDP 命令后 Electron exit 可假绿、CDP 初始化失败可能泄漏 child；第二轮又动态证明纯 CDP close 未进入 fatal latch，并发现 ZIP 的 412 个 `._*` AppleDouble 会让标准 unzip 后签名失效。上述缺口均先复现再修复，说明外层 `--deep`、同工具打包/解包、自增 passed 计数和单一 client abort 都不能替代终态证明。
- **最终独立复审（历史）**：**P0=0/P1=0/P2=3，允许技术签字**。当时 P2 为：Watcher 1.5 秒稳定窗不是 Main 显式 flush barrier；native reserve 的 `mkdirat→openat` 极窄 external-process/失败空 stage 残余；build-info 的 C source/binary hash 是并列证据，直接绕过标准 `npm run package:mac` 时不是强因果证明。Watcher 时间窗已由 0.0Q exact barrier 关闭；reserve/build 分别由 0.0U 明确威胁模型与 0.0S 哈希链收口。它们都不是当前下一本地任务。
- **历史下一步（已执行并被取代）**：0.0P 已在提交 `1944950` 完成文档/Nowledge/Git 收口；当时要求先升级 Watcher 时间静默证据，再进入真实旅程。当前只按本文顶部当前里程碑停点续作。

### 0.0O 2026-07-27 真实作者验收预检与隔离副本底座

- **产品缺口**：冻结合同要求真实项目具备有效 `edit.md`、至少 5 章、2000 个可见中文字符、来源材料和可逆快照，但此前只有文字要求，没有安全预检或工作副本工具。
- **实现**：新增 `src/main/author-acceptance-preflight-service.js` 与 `scripts/prepare-author-acceptance.js`。默认预检完全只读；公开报告只含固定 schema、合格状态、计数、稳定错误码和 SHA-256 快照，不含绝对路径、文件名列表、Prompt 或正文。
- **隔离副本候选**：CLI 同步事务用 cwd/inode 绑定源与目标目录；资格和复制来自一次权威扫描。随机私有 stage 先完成精确写入、权限校验和 readiness fsync；最终源复核是最后一个预提交动作，随后原生 helper 通过继承的 parent fd 和相对 stage/final 名执行 `renameatx_np(RENAME_EXCL)`。primary report 与 secondary inspect 形成已提交/未提交/未知三态；未知态标记 `committed:true`，不进入清理。清理只移除本次拥有的精确身份，遇到 foreign 或目录替换立即停止。
- **当前环境预检**：真实 API 离线合同 **15/15、0 网络**；稳定 App 配置仅报告 `CODING_PLAN`，因此未触发付费图片。最近项目的公开预检为有效 `edit.md`，但 `chapters/` 0、可见中文字符 0、来源 0，明确不合格；未扫描其他私人目录。
- **验证**：Author Preflight **39/39**；`npm run verify:author-acceptance` 合计 **54/54、0 网络**；最终精确候选完整 `npm test` exit 0；沙箱内 verify 只因 Electron 被终止，沙箱外同命令 exit 0；受控强制真实 Electron **32/32**。
- **Electron 波动如实保留**：日终最终重跑第一次在 Onboarding fresh one-time confirmation 等待处超时（1/32 后红灯），未改源码立即同命令复跑为 **32/32**。这证明当前存在非确定性时序 P2；绿灯不覆盖首个红灯。下次进入发布前须在该等待点补状态诊断，并完成连续稳定复跑或定位 watcher/confirmation ownership 时序。
- **六轮复审与候选修复**：首轮 **P0=0/P1=6/P2=2**；后续复审继续发现目标换壳、绝对路径 helper 误发布、stage 身份采用和双 helper 证据丢失误报未提交。所有 P0/P1 均已动态关闭，最终独立技术复审 **P0=0/P1=0/P2=3，可以代码签字**。P2 为 native `mkdirat→openat/fstat` 极窄外部替换残余、干净 macOS `/usr/bin/python3` 依赖，以及 reserve 回执丢失可能遗留空 0700 随机 stage。
- **后续覆盖**：本节的 Python 依赖与 Onboarding flake 已由 0.0P 根因关闭；其余历史过程保留用于追溯。当前下一步只看本文顶部当前里程碑。
- **当日复盘**：正确动作包括离线 API 合同 0 网络、凭据只报类型、只检查 App 最近项目的公开计数、不扫描其他私人目录，以及在 Coding Plan/不合格项目处停下。主要失误是先实现顺序式 happy path，再补安全测试；没有在编码前冻结“源快照—祖先身份—目标所有权—提交真相”矩阵，导致 11/11 和全链绿灯仍漏掉 6 个 P1。今天不提交该 WIP，避免把不可签字状态写进 `main`。

### 0.0N 2026-07-27 应用内 Image Trash 恢复/清空闭环

- **用户体验**：Chat 配图面板新增可见“图片废纸篓”，显示数量、总容量和“长期保留·不会自动删除”；作者可逐项恢复到 `assets/generated/`，也可在明确“无法撤销”确认后永久清空当前核验快照。
- **精确权限**：Renderer 只持有项目实例与 `iti_`/`its_` 不透明能力；Main 独占 root、目录、inode、digest 和文件写删权。列表只返回有界时间/大小元数据，恢复/清空经过可信窗口、当前项目、mutation/navigation 和 mutable-project 门禁。
- **并发与真相**：恢复/清空先把精确路径原子移动到随机私有 transaction quarantine，再核验 inode/大小/digest，避免 `lstat→unlink` 窗口误删外来文件；恢复发布失败会清理由本次创建的 exact inode。同 inode 同尺寸原地改写、pre-link/path replacement、late arrival、部分提交、committed-then-threw、目录 fsync 与跨 TTL 精确重试均有动态回归。
- **保留策略**：V0 不做后台或定时永久删除。清空只删除 opaque snapshot 当时核验的条目；期间新进入的图片保留。恢复和清空均不修改 Markdown、`edit.md` 或 `.writcraft/image-reviews.json`。
- **该专项历史证据**：Trash Service **21/21**、Handler **7/7**、Main/preload Integration **4/4**、Renderer **7/7**；完整图片专项 **107/107**、沙箱外 `npm run verify` exit 0、真实 Electron **32/32**。0.0AB 后续曾推进到 35/35；当前项目总链见顶部当前里程碑。
- **独立复审与错误沉淀**：第一轮在 15/15 后发现 path-based unlink、committed TTL 和 restore 原地改写 3 项 P1；第二轮在 19/19 后继续发现 empty 缺 digest 快照与 pre-link replacement 遗留 foreign target 2 项 P1。五项均已关闭并增至 21/21。最终独立只读 sign-off 为 **P0=0/P1=0/P2=1，可以签字**；P2 仅是非协作外部进程预持 open FD 并在最后 digest 后改写同一 inode 的 POSIX 通用极窄残余，不会按旧路径误删替换文件。
- **稳定性复盘**：竞态用例曾固定假设 `first` 一定先处理，但 `createdAt`/birthtime 排序并不保证该顺序，导致次日复跑偶发失败。测试现对“实际首个被处理条目”注入竞态，仍严格断言 foreign 内容保留、未处理 peer 不被删除；service 连续 20 轮 **20/20**，不是放宽产品断言。
- **该批当时的下一步（历史，已被 0.0O–0.0R 重排）**：原计划进入真实 `sk-api-`/作者证据；当前续作顺序只看本文顶部。不得再次扩展 Image Trash，也不得用 fixture 质量替代真实作者判断。
- **当日复盘**：今天完成了从“图片只能移入废纸篓”到“用户可看见、恢复、确认清空且不误删并发替换”的产品闭环，并把五项复审发现的竞态缺口全部关闭。一次次日复跑失败并非产品回归，而是测试错误假设 fixture 创建顺序等于生产排序；修正为注入实际首个处理项后连续 20 次通过。另一次流程错误是把 10 秒工具轮询超时误当成 5–10 分钟复审交付窗口，过早中断 reviewer；后续规则是先给新 reviewer 一个真实证据窗口，再按约定 checkpoint 判断是否接管。这两条已写入 `AGENTS.md`。

### 0.0M 2026-07-26 Image Review v1 自动化闭环（历史已签字基线）

- **用户体验**：生成图片后展示真实解码尺寸与请求比例；作者必须给 1–5 分，可选录入两位小数费用及 CNY/USD，再明确选择“插入当前正文 / 保留素材 / 移入废纸篓”。未结算图片会阻止重复生成和项目切换。
- **写入权**：生成本身不改 Markdown；插入仍通过 Workspace 保存门并把目标 revision 交回 Main 核验。保留不改正文；删除改为移动 token 所属精确 inode 到 `.writcraft/image-trash/`，不是永久删除。
- **Main 权威与隐私**：短期 token 绑定可信窗口、项目、mutation/navigation、operation 与资产身份；Renderer 不持有 root、digest、绝对路径、Key 或图片字节。`.writcraft/image-reviews.json` 只记录 operation、评分、终态、可选费用和时间。
- **可靠性**：生成目录、诊断导出父目录及图片证据临时文件均补 inode/canonical/nlink 复核与精确清理；插入或废纸篓移动已提交但证据写入失败时保留可恢复真相，精确重试不重复插入或移动。
- **作者证据可见**：配图面板显示项目累计样本、平均评分以及插入/保留/废纸篓计数；生成耗时与失败仍由既有八字段隐私指标负责，不把 Prompt、正文或远端错误写入评审证据。
- **该历史批自动化**：Generation **15/15**、Review Service **16/16**、Handler **9/9**、Renderer **8/8**、Metrics Renderer **20/20**、Network **15/15**；当时 `npm test` 与 Electron-enabled `npm run verify` exit 0，强制真实 Electron **31/31**，Persistent Watcher **3/3**。该数字只证明 Image Review 专项；0.0AB 后续曾推进到 35/35，当前项目总链见顶部当前里程碑。
- **独立复审**：首轮发现 3 项 P1 与 3 项 P2；已关闭生成后签发失败孤儿、committed inserted 恢复受旧 revision 阻断、evidence rename 后 fsync 未补做，以及 handler map、诊断部分文件清理问题。最终 **P0=0、P1=0、P2=1**。
- **当时未完成边界（已被 0.0N 部分覆盖）**：真实 `sk-api-` 图片质量/费用/限流/超时、真实作者判断和发布包均未签字；本批当时唯一 Image Review P2 是缺少应用内废纸篓恢复/清空，现已由 0.0N 实现。Graph 另有顶部列明的两项历史保留 P2，不得混为同一复审范围。App/ZIP 继续禁止分发。
- **今日交付**：建立本地 Git `main` 基线；完成并独立签收 Diagnostic Export v1；把 Image Review 从“生成后插入/放弃”升级为评分、费用、三类终态、可恢复废纸篓和项目聚合，并在复审修复后签收自动化链。
- **今日过程错误**：Image Review 首轮绿灯后过早进入完成表述，独立复审仍找出 3 项 P1；诊断“部分写入”最初只在写入前抛错，没有真实写入字节；rename 后 fsync 重试最初只证明文件可读，没有证明第二次目录 fsync；旧测试一度仍按旧 IPC 契约判断；文档逐项更新后仍残留 0.0L、12/12、30/30 和“待复审”等过期说法。
- **明日效率规则**：先执行无外部依赖的废纸篓 UI 闭环；任何付费或不可逆动作先做容量/authority 预检并取得 owner lease；故障注入必须穿过真实副作用边界；实现绿灯后必须独立复审再签字；日终横向核对源码、测试、README、PRD、Phase A、专项契约、PDCA、状态台账和同一条 Nowledge 权威记忆。

### 0.0L 2026-07-26 Diagnostic Preview / Export v1 自动化产品链签收

- **用户体验**：设置页新增“诊断与隐私 → 预览诊断信息”。作者先看到可能导出的完整 UTF-8 JSON 和排除说明，只有显式点击“导出这份诊断”后才打开原生保存窗口；关闭、刷新或取消均不写文件。
- **隐私边界**：Main 只构造递归 exact-key allowlist，内容限于应用/运行时版本、项目是否打开、文件数量、`edit.md` 结构状态、watcher 状态、私有指标计数和稳定诊断码。正文、来源文字、Prompt、模型回答、quote/base64、Key/指纹、项目/文件名、路径、revision/hash、原始错误和 Renderer console 内容全部禁止进入预览。
- **权威边界**：preload 只暴露 `preview()` 和 `export(token)`；Renderer 不提供 JSON、URL 或输出路径。token 绑定可信窗口、项目实例、mutation generation 和 navigation epoch，五分钟过期；项目/页面漂移在保存窗口前后都阻止写入。
- **磁盘安全**：Main 使用原生保存窗口、`wx` 不覆盖打开、`0600`、fsync。写入失败只清理由本次创建且 inode 仍匹配的目标，已有文件、符号链接或并发替换都不会被删除。
- **本批真实缺陷与关闭**：首次 no-overwrite 测试发现 EEXIST 后清理会误删已有目标，已改为“只有本次成功创建才清理”；进一步加固并发替换 inode 门禁。独立复审又发现同步 write/fsync 跨过 token TTL 时可能“已落盘却报失败”，现由 `consumeCommitted` 保持落盘真相并确保 token 不可重放。
- **测试主链**：新增 `verify:diagnostics` 并接入 `pretest` / `preverify`；当批 Service **12/12**、Handler **10/10**、Renderer **7/7**、Network Boundary **15/15**；本轮父目录竞态回归后 Service 为 **13/13**。完整链证据以本文顶部为准。
- **真实 Electron 证据**：在真实项目和可见设置页打开精确预览，验证 schema/字段/文件计数，且项目名、正文 marker、相对/绝对路径、文件名和 `edit.md` 均不出现；关闭后当前文件与正文保持不变，后续 Plan/Graph/Chat/Research/重启链继续通过。
- **独立复审**：Main/验证复审发现并关闭上述 TTL postcommit P1；Renderer/preload 独立检查为 P0=0/P1=0。最终结论 **P0=0、P1=0、P2=0**。该签字不替代真实 API、真实作者、真实导出人工保存和发布验收。

### 0.0K 2026-07-26 本地 Git V0 基线

- 项目根目录已初始化本地 Git 仓库，默认分支为 `main`；这是后续代码审计、回退和阶段提交的起点，不追溯此前开发历史。
- 根 `.gitignore` 与 `v0/.gitignore` 共同排除 `.env*`、私钥文件、`node_modules/`、`release/`、构建目录、日志、macOS 元数据和本地 Agent 运行状态；`.env.example` 保留为安全配置模板。
- 2026-07-26 首次本地基线提交当时未配置 remote、未连接 GitHub，也未上传任何内容；现有 342 MB `release/` 和 322 MB `node_modules/` 未进入历史。该句只描述历史基线，0.0AG 已建立并推送公开 `origin`。
- 后续每项功能必须把实际源码、对应测试和受影响文档放在同一提交中；验证结果仍需注明真实 Electron、真实 API 或 fixture 范围，Git 通过本身不等于产品验收。

### 0.0J 2026-07-26 Changes/History durable recovery 全链签收

- **原始缺口与关闭结果**：普通 apply/undo 在 History 写入和正文回滚同时失败时可能形成混合磁盘状态。现在原能力在 durable marker 后即终结，Renderer 不再把不确定结果当普通可重试失败，而是先锁定项目、查询磁盘与 History 真值，再自动恢复或要求人工二选一。
- **完整范围**：同一协议必须覆盖 `rollback_failed`、`history_failed_rollback_failed`、History 实际提交后 writer 抛错、reject-only/apply/undo response loss，以及 apply 成功后的 residual/onboarding/tree bookkeeping 异常；不能只补一个错误码。
- **冻结合同**：`docs/CHANGES-HISTORY-RECOVERY-V1-CONTRACT.md` 已冻结 applying/terminal marker、权威磁盘+History 真值矩阵、全局 mutation lock、重启 reconciliation，以及“恢复操作前 / 保留操作后并补 History”两项 Main-owned 人工恢复动作。第三种 revision 或外国 History 一律继续锁定。
- **核心实现已签收**：新增 `changes-history-reconciliation-service.js` 与 `changes-history-transaction.js`，重构 History prepare/execute/expected-state CAS；首次 marker 使用不可覆盖的原子发布，人工恢复写前持久化 `recoveryWritePending`，目录 fsync 失败保持锁定，重试成功才释放。accepted review 归入 apply 真值，reject-only 保持 review。
- **核心证据**：Recovery **24/24**、History **14/14**、Review **15/15**、Composite Guard **5/5**、旧 Inline Integration **7/7**；第三轮独立复审 **P0=0、P1=0、P2=0**。覆盖 apply/undo 双失败、writer committed-then-threw、response loss、History CAS、跨进程 marker 竞争、symlink/hard-link/corrupt/oversize、两项恢复、恢复重试和 fsync durability lock。
- **跨层实现**：生产 Main handler、IPC 与窄 preload 已统一进入 Changes/History transaction；Research apply 复用同一 durable authority。Renderer 启动顺序固定为 Changes→Inline→打开可编辑内容，apply/undo 都执行“锁定→查询→权威重载 tree/current/History→精确 clear→解锁”。Inline 与 Changes 使用独立 blocker，项目 A 的迟到结果不能污染项目 B。
- **人工恢复体验**：恢复面板列出受影响相对路径并提供“恢复操作前 / 保留操作后”。reload、clear 或恢复写失败继续锁定；同一选择可重试。`keep_after`、`restore_before`、首次失败后同动作重试均有动态证据。
- **错误契约**：统一返回 `writcraft.changes-history-error/v1`；Graph Issue 未完成全部修改块时保留 `ISSUE_REVIEW_INCOMPLETE`，不消耗原 capability，也不写正文或 History。
- **最终证据**：Handler **10/10**、Renderer 协议 **16/16**、Workspace 恢复 **7/7**、Changes integration **6/6**；完整 `npm test` 与 Electron-enabled `npm run verify` 均 exit 0，真实 DOM sanitizer **13/13**，强制真实 Electron **30/30**。真实 Electron 覆盖 response loss、两项人工恢复、首次失败后同动作重试、History undo、Graph Issue 完整决策及后续 Chat/Research/重启链；最终独立复核 **P0=0、P1=0、P2=0**。

### 0.0I 2026-07-26 Graph 三项韧性缺口完整签收

- **异步所有权**：Graph build、correction persist/build 和同项目连续 refresh 均绑定项目实例与递增请求序号；旧项目或旧请求的延迟 resolve/reject 不能覆盖当前 Graph。真实 Renderer VM 已覆盖 A→B、persist 中切项及同项目后发请求胜出。
- **输入权威**：Graph Index 对每个 Main 权威文件快照使用内置分析器重建 canonical contribution；自洽伪缓存会以 `AUTHORITY_SNAPSHOT_MISMATCH` 仅重析受影响文件，伪造 injected analyzer 语义会以 `ANALYZER_AUTHORITY_MISMATCH` fail closed。quote、revision、locator、block/content hash 与完整 nodes/edges/issues 语义均不能由缓存自行背书。
- **不可变快照**：Renderer 接收 Graph 后先做有界 structured clone + recursive freeze；getter、accessor、hidden/symbol 字段、稀疏/超长数组、异常 prototype 与 cycle 全部 fail closed，getter 读取次数为 0。Correction 可能已提交 ledger 后若返回非法 Graph，会清空旧 Graph/DOM/issues/detail/cache/selection 并保留 live-region 错误。
- **Unicode 与性能**：Evidence quote 在 240 个 UTF-16 单元边界遇到 high surrogate 会回退一单元，`quote/end/id` 全部基于最终合法字符串。300 文件实测 cold **92.2ms**、cache **60.5–66.9ms**、单文件 incremental **80.7ms**，低于 2500/700/800ms 门禁。
- **最终证据**：Consistency **22/22**、Index **15/15**、Filter **17/17**、Workbench **14/14**、Renderer Dynamic **14/14**、Large **5/5**；完整 `npm test` exit 0；Electron-enabled `npm run verify` exit 0（真实 DOM sanitizer **13/13**）；强制真实 Electron **28/28**；独立二审 **P0=0、P1=0、P2=0**。

### 0.0H 2026-07-23 Research committed-warning 动态故障边界最终签收

- **生产事务边界**：新增 `src/main/research-apply-transaction.js`，Main 的 Research apply 分支真实复用该事务；错误决策在 `beginApply` 前拒绝，提交前 stale/conflict/history failure 保持普通失败，`applyDecision.ok` 后的 bookkeeping、residual、tree 与状态迁移异常一律保持 `ok: true` 的已提交真相。
- **权威结果与单次能力**：committed warning 保留精确 `applied` revision、History 与 Research provenance，强制 `review/changeSetId = null`、`residualUnavailable/refreshRequired = true`；旧/新 capability 均不可重放，卡片按原因进入 STALE / FAILED / EXPIRED。
- **极窄竞态关闭**：即使真实 `finishApply` 已安装 residual 并把卡片推进到 REVIEW 后才暴露异常，也会只结算 exact card/lease/residual，回收 child 并进入稳定终态。`clearExcept` 只在项目派生状态失效期间暂留当前 Research child，随后以非 owner-revoking 原因精确删除。
- **真实故障矩阵**：scratch 项目从真实 Research run → handoff → ACK → Pending Store → ChangeSet/History 执行生产事务，动态覆盖 partial baseline、post-commit source stale、TTL、residual put、finish-after-REVIEW、tree、result getter、reject-only、malformed/pre-apply stale、真实 conflict 与 History rollback。
- **最终证据**：Research transaction **11/11**、handoff **15/15**、integration **12/12**、Pending Store **12/12**、History **14/14**；完整 `npm test`、Electron-enabled `npm run verify` 均 exit 0，强制真实 Electron **28/28**。独立二审最终 **P0=0、P1=0、P2=0**。
- **历史相邻风险已关闭**：本段当时保留的普通 Changes History+rollback 双失败缺口，已由 **0.0J** durable reconciliation/manual-recovery 全链关闭，不再是 TODO。

### 0.0G 2026-07-23 Onboarding single-flight 与 Renderer 生命周期最终签收

- **Main single-flight**：同一 `project.instanceId + rootPath` 同时只允许一个项目卡模型调用；第二请求在付费调用前返回 `ONBOARDING_PROPOSAL_IN_PROGRESS`，不共享首请求 Promise、结果或 capability，也不能释放首请求 lease。
- **精确释放**：success、service rejected、throw、project/generation/navigation drift 均由 owner identity-checked `finally` 释放；新页面不能把 navigation epoch 加进 key 来绕过仍在结算的旧 lease。
- **两侧页面竞态均关闭**：请求捕获 Renderer navigation epoch，模型返回后、任何 authority mint 前复核。导航发生在 await 期间时零 authority；authority 已 mint 但 IPC 尚未送达时，`did-start-navigation` / `render-process-gone` / `destroyed` 会 abort 活动 AI、推进 epoch，并按 exact current project 撤销 Onboarding review/confirmation 及其配对 ChangeSet。
- **清理边界**：项目级 invalidation 只匹配 `instanceId + rootPath` 的 Onboarding review map 与配对 ChangeSet；普通和其他项目 ChangeSet 保持不变。动态测试分别覆盖 no-op confirmation 与 changed review 的清理、保留 unrelated ChangeSet 和立即重试。
- **最终证据**：Handler **11/11**、Main/preload **14/14**、Changes integration **5/5**、Network boundary **13/13**；完整 `npm test`、Electron-enabled `npm run verify` 均 exit 0；强制真实 Electron **28/28**。两轮独立复审依次发现 await→mint 与 mint→IPC delivery 两个 P1 窗口，修复后最终 **P0=0、P1=0、P2=0**。

### 0.0F 2026-07-23 Onboarding Main 动态 admission 阶段签收（已被 0.0G 覆盖）

- **生产路径可执行测试**：`writcraft:project:propose-onboarding` 已复用 `project-onboarding-handler.js` 的 handler factory；动态测试直接执行同一生产 factory，覆盖并发返回、已有 authority 的 pre-model 阻断、TTL、项目/generation drift。
- **双向对账修复**：独立复审发现共享 Pending ChangeSet 容量驱逐会留下 review capability 孤儿。admission 现按 exact `changeSetId` 对账；配对 ChangeSet 已不存在时，只撤销对应 `reviewId` 和 map 项，不删除 unrelated ChangeSet。真实 `maxEntries:1` 驱逐回归已固化。
- **原子回滚证据**：batch 故障注入显式锁定 `ROLLBACK_FAILED → COMMIT_FAILED → force rollback` cause chain，同时保持目标、stage 与 replay authority 全部清理。
- **该阶段证据**：Handler **6/6**、Changes integration **5/5**、Main/preload **13/13**、Capability **15/15**、Batch **22/22**、Network boundary **13/13**；当时完整 `npm test`、Electron-enabled `npm run verify` 均 exit 0、强制真实 Electron **28/28**。该阶段遗留的并发付费 P2 已在 **0.0G** 关闭，不能再作为当前 TODO。

### 0.0E 2026-07-23 Chat 动态失效与 Main 权威取消最终签收

- **动态覆盖补齐**：真实 Electron 分别覆盖 Chat 重开、正文 collapsed selection 与当前文件外部权威修改；每个场景使用唯一问题/响应，避免历史消息造成假阳性。
- **竞态根因与修复**：Main 会先推进项目代际并返回 `PROJECT_CHANGED`，Renderer 的 watcher 事件可能稍后才完成。Chat 现在把该精确权威结果统一归类为“请求已取消”，不再短暂显示“调用失败”；项目内与 standalone→打开项目两条路径均适用。
- **所有权边界**：取消仍在 request token/phase 门禁后执行，只能清除该请求的 preflight，不能擦除更新请求或 actual provenance。
- **最终证据**：Chat directed **11/11**；完整 `npm test` exit 0；Electron-enabled `npm run verify` exit 0（DOM sanitizer **13/13**）；强制真实 Electron **28/28**。最终独立复审 **P0=0/P1=0/P2=0**。

### 0.0D 2026-07-23 Chapter no-op/provenance-invalid 最终签收

- **运行态分类器**：Renderer 生产路径统一把 Main 响应分类为 invalid / no_changes / review；拒绝原型继承对象、错误 target/revision、context 顺序/角色、generation schema、no-op capability/review 泄漏，以及 review inner/outer capability、file policy、唯一目标路径不一致。
- **能力回收**：所有带 capability 的 invalid 响应先按 origin project 确认回收；只有 `ok:true` 或 `CHANGESET_NOT_FOUND` 算完成。失败时不再假称“安全取消”，而提示切换项目或重启笔触。`capabilityReleased` 防止 ownership drift 后重复 discard，同时允许未确认回收走 stale 路径重试。
- **独立复审过程**：首轮发现 capability 回收断链和 review/目标未绑定 2 个 P1，以及 plain-object、provenance 完整性、回收确认 3 类 P2；全部复现并修复。最终独立复审 **P0=0/P1=0/P2=0**。
- **该批签收证据（已被 0.0E 当前总链覆盖）**：Chapter Contract **17/17**、Changes Proposal Transaction **23/23**、Changes Review Integration **5/5**、Pending Store **11/11**、Review State **6/6**；当时完整 `npm test` exit 0、Electron-enabled `npm run verify` exit 0（DOM sanitizer **13/13**）、强制真实 Electron **27/27**。

### 0.0C 2026-07-23 Chat preflight 生命周期 P2 关闭

- **实现**：Context Chips 区分当前请求的 `preflight` 与 Main 实际响应 `actual` 所有权；只允许精确 request token 清除当前 preflight，旧请求不能删除新请求或 actual provenance。
- **主动失效**：scope、selection、`editVersion`、Chat 重开后的隐式 scope、正文内主动折叠选区，以及重命名/移动/回收/外部修改/Inline reconciliation 等 workspace 权威状态变化都会在 guard 失效后同步清除 preflight。焦点进入 Chat 不会被误判为正文主动清空选区。
- **真实竞态门禁**：Electron fixture 延迟旧 Chat 700ms；测试等待带 sentinel 的 preflight DOM 真正替换旧 actual，随后改变 scope、发起新请求并等待旧请求迟到。结果为旧 preflight 立即消失、旧回复不落地并标记取消、新 actual 不被旧 token 擦除，actual 经 scope 变化仍保留。
- **该批复审与验证（已被 0.0E 当前总链覆盖）**：独立二审确认原 3 个实现 P2 已关闭，P0=0/P1=0；当时 Chat directed **10/10**、完整 `npm test` exit 0、Electron-enabled `npm run verify` exit 0（DOM sanitizer **13/13**）、强制 Electron **27/27**。
- **后续状态**：本段当时保留的三条动态测试增强已在 **0.0E** 全部关闭，不再作为续作 TODO。

### 0.0A 2026-07-23 额度收口检查点

- **Plan P2 已形成完整小批次**：新增 Main-owned 可注入 handler，并让真实 IPC 注册复用它；动态测试直接执行同一 handler factory，证明 service 返回 rejected result 时 `pendingPlanRecords` 保持为空、mutation generation 保持不变，且不会读取后置 current-project 成功路径。`package.json` 与 release 产物未修改。
- **本批可复现证据**：相关文件 `node --check` 通过；Project Plan **19/19**、Plan handoff **15/15**、Assistant integration **11/11**、Network boundary **13/13**，最终测试文件上的完整 `npm test` exit 0。独立复审结论 P0=0、P1=0、P2=0。
- **未执行的全链门禁**：本批因额度收口未重跑 Electron-enabled `npm run verify` 或强制真实 Electron；此前 **26/26** 只作为抽取前最近签字基线。进入发布验收前必须在当前源码上重新跑全链。
- **Plan handler P2 已全部关闭**：同一生产 factory 已动态覆盖 rejected result、success cache、模型返回后的项目/generation stale、抛出异常→`projectFailure`；Main 注册片段逐项断言全部十项注入，测试命名不再误称为真实 Electron IPC 启动。
- **恢复来源**：本文是唯一权威状态台账；跨会话摘要同步到 Nowledge Mem，不在项目内制作重复副本。
- **当时下一目标（已被后续状态取代；当前见顶部当前里程碑）**：真实作者项目定义旅程仍需执行；0.0O 后续六轮复审已于本日完成，Python helper 门禁也已由 0.0P 关闭。当前门禁见本文顶部。
- **当时外部依赖判断（已被 0.0AC 推翻）**：该检查点曾误把完整 `sk-api-` 当作 `image-01` 的必要条件。当前按顶部当前里程碑：`sk-cp-`/`sk-api-` 都由 provider 套餐与额度现场判定；真实作者质量、费用和采纳仍不得伪造。
- **额度门禁**：任何后续开发若剩余额度接近本轮水平，先停止扩展实现，同步本文、相关合同和 README，再更新 Nowledge Mem 主记忆；不制作额外项目副本。

### 0.0B 2026-07-23 Graph 性能复验最终签收

- **复验先绿后失败**：Plan handler 抽取后的 Electron-enabled `npm run verify` exit 0，真实 DOM sanitizer 13/13；根 lane 首次强制 Electron 26/26。独立 lane 随后在第 10 阶段发现 `graph-file-filter` 单次 **233.8ms > 100ms**，证明一次绿灯不足以签字。
- **第一层根因与修复**：`graph-filter-state.nodePaths` 曾为每个节点重建整张 evidence Map，文件筛选近似 O(nodes×evidence)；Graph 也会为每个投影重新布局。现按 Graph 快照缓存 evidence/path 派生，筛选复用全图稳定坐标，并只渲染两个端点都可见的 edge。定向套件提升为 Filter 16/16、dynamic 6/6；根 lane 强制 Electron 26/26，但独立 lane 清除筛选仍为 **163.8ms > 100ms**。
- **第二层根因与修复**：慢操作的 value 为空，实际是清除文件筛选恢复全图。secondary file/time/query scene 曾覆盖 baseline 全图 scene，导致清除时同步重建 1279 节点。缓存所有权随后被收紧为 exact graph/scope/currentPath/selectedNode，布局与节点身份不再随 secondary filter 重建。
- **第三层根因与修复**：恢复 baseline 虽未重新创建元素，仍会把全部原始 node/edge 从 projection scene 同步移回，`issues → all` 曾实测 **150.5ms > 100ms**。当前类型筛选改为 scene 级 CSS 可见性，file/time/search 使用同一 baseline 上的 secondary 隐藏标记；任何投影都不再搬移节点、边或丢失键盘/AX 身份。
- **门禁自身缺口与修复**：首次实现仍在缓存判断前无条件 detach/reappend 整棵 SVG scene，且旧 E2E 在 `dispatchEvent` 返回即停止计时，未包含 CSS 可见结果。现只有 cache miss/new scene 才替换 SVG；dynamic 测试真实统计 detach 为零并锁定键盘节点 parent。Electron 对每次 type/file/time-start/time-end/search 更新等待两帧、读取 `getComputedStyle` 与 SVG layout 后才记录耗时，失败信息包含序号、from/to 与完整 durations。
- **最终定向证据**：相关 `node --check` 全过；`npm run verify:graph-renderer` exit 0，Graph Filter **16/16**、Workbench **14/14**、Renderer dynamic **9/9**、Large **5/5**。独立最终复审 P0=0、P1=0、P2=0。
- **该 Graph 性能批签收**：当时源码完整 `npm test` exit 0；沙箱外 Electron-enabled `npm run verify` exit 0（DOM sanitizer 13/13）；随后在无中间源码修改下连续两次强制真实 Electron 均为 **26/26**。两轮均通过新的可见帧 ≤100ms 门禁；Graph 性能复验关闭，不再以旧失败或单次 retry 绿灯继续循环。当前总链见本文顶部。
- **保留 P2｜非阻塞**：WeakMap 路径缓存依赖当前生产约定——Renderer Graph/Node 是整体替换的不可变快照；刷新、纠错、项目切换都满足，但尚未通过 freeze/version 机械强制。后续应冻结契约或增加显式 cache version。
- **Nowledge 同步**：额度恢复后已先更新现有 WritCraft 主记忆；本次最终签收在本文与 Graph 合同落盘后继续更新同一记忆，不制作项目副本。

### 0.0 文档同步门禁（2026-07-22 第十二次收口后固化）

- **职责分离**：当次磁盘源码与可复现命令结果优先；本文记录当前结论、风险和下一步；合同记录对应产品链的冻结边界；`docs/ROADMAP.md` 唯一负责版本顺序、当前目标与范围/非目标。README 只作产品概览，PDCA 与 `deliverables/` 只作历史背景。
- **每批必做**：任何功能完成、缺陷关闭、独立复审或全量验证，在开始下一项开发前，同步更新本文及受影响的合同、README 和路线图；未更新的旧 TODO 不得继续执行。
- **历史数字标注**：20/20、21/21、26/26、28/28 等局部或旧源码数字必须说明日期和覆盖范围，且明确“非当前项目总链”；当前总链只能引用本文顶部的实际执行边界。
- **续作检查**：恢复任务先读 `docs/ROADMAP.md`、本文、相关合同和 `package.json`，再运行最小能验证当前判断的命令；若文档与源码/命令冲突，先修文档或状态结论，禁止以旧文档扩展修复范围。
- **该历史批审计结果（2026-07-27 0.0N 最终复核）**：README、PRD、Phase A、作者验收合同、Image Review 专项合同、`AGENTS.md` 与本文当时已按 Trash 签字同步；产品总链提升为 **32/32**，0.0M 的 31/31 降为历史基线。其后 0.0O 技术候选已完成六轮复审并签字，当前门禁见本文顶部。

### 0.1 Research Accuracy v1 最终签字（2026-07-22）

- **已签字能力**：来源打开后显式“主张匹配/主张不匹配”、不匹配保持 Changes 锁定、同卡改判替换而非新增样本、项目私有聚合，以及窄化的 Main/preload IPC。
- **该批定向证据（历史）**：Research judgment transaction **10/10**、project watcher health **4/4**、Persistent Watcher real Main/IPC **3/3**、Legacy migration **12/12**、Inline integration **7/7**、Graph Issue handoff **6/6**、Network boundary **13/13**；此前同批 Sources UI **16/16**、Sources race **5/5**、Research Renderer **13/13**、Metrics service **18/18**、Watcher **16/16**、Research handoff **15/15**、Metrics integration **8/8**、Research integration **12/12** 当时均绿，相关 `node --check` 全过。当前总链只看本文顶部。
- **P1-1｜已修并通过第四轮复审**：任何 filename-less watcher 事件继续 fail-closed，不按公共 Markdown 指纹猜测内部回声。判断事务先验证无并发 mutation、取得 exact owner/navigation/READY lease 并解析 live authority，之后才推进 generation 与 pause/flush；无效、非 READY、错误 owner 或 stale 请求对 generation 和其他工作保持零副作用。
- **P1-2｜已修并通过第四轮复审**：专用 metrics 写入在原子 rename 前重验完整公共指纹与 canonical card/source/revision/grade/quote；重启 watcher 后再做终检，只重绑 exact card，同 run sibling 保持旧代际。连续重启失败会设置与 exact project instance/root 绑定的 degraded 门禁，后续 `runAiRequest`、`requireMutableProject` 与 Changes apply 均返回 `PROJECT_WATCHER_UNAVAILABLE` 并要求重新打开项目；成功重新挂载 watcher 后才清除。
- **Renderer 诚实状态｜已接通并通过第四轮复审**：只有 `ok && recorded && handoffAvailable === true && evidenceChanged === false` 才解锁交接。若 Main 返回“判断已记录，但证据随后变化/监控不可用”，旧卡片会锁定来源、判断按钮与 Changes，展示 Main 消息，且不得重试旧卡片或进入 Changes。
- **第三轮新增 P1｜已修并通过第四轮复审**：项目进入 watcher-degraded 后，`writcraft:rewrite:apply`、`confirm-legacy-edit` 与 `handoff-graph-issue` 曾可在 Main AI 门禁前进入正文、History 或 Graph 私有状态写入。Inline apply 与 Graph handoff 现使用 `requireMutableProject()`；legacy confirm 在已有同根 current project 时使用 exact project health/mutation gate，但保留“首次迁移尚无 currentProject”的合法流程，迁移后由 `openProjectRoot` 建立 watcher。
- **第三轮恢复缺口｜已修并通过第四轮复审**：`projectService.openProject` 对同一路径生成稳定 instanceId；`setCurrentProject` 现在识别 same-binding degraded/null-watcher 的显式恢复入口并真实 restart。失败保持 degraded，成功才 clear；动态回归调用生产 `openProject` 同路径两次，而非伪造新 instanceId。
- **第三轮扫描扩展｜已修并通过第四轮复审**：Inline reconciliation / reconciliation-clear 可能写 marker 或 History，现均在副作用前执行 exact watcher health gate；全 handler 扫描其余 `requireCurrentProject` 命中只涉及读操作或内存 capability 清理。
- **已冻结的线性化语义**：原子 metrics rename 前的最后一次权威重验是“作者判断成立”的时点。若来源仅在该时点之后变化，当时有效的历史样本可以保留，但 exact card 不得重绑、Changes 必须保持锁定，UI 必须明确提示“判断已记录，但证据随后变化”；不得把 sibling card 一并复活。
- **第四轮复审发现与最终关闭**：第四轮曾保留 P2——真实 Main/IPC persistent-failure 零副作用 harness 尚未固化。现在新增 `verify-v0-watcher-persistent-main-ipc.js`，从真实 BrowserWindow 经正式 preload/IPC 验证 degraded 下 rewrite apply、Graph handoff、Changes reconciliation query/clear 与已有同根 legacy confirm 全部返回 `PROJECT_WATCHER_UNAVAILABLE`；递归 lstat/mode/SHA-256 快照证明公开文件、History、recovery 与私有 metadata 零变化，首次无 current project 的 legacy migration 仍原子成功。
- **安全测试注入**：`WRITCRAFT_E2E_WATCHER_FAILURE=1` 只有 unpackaged + AI fixture + watcher failure 三重 Main-only gate 同时满足才可达；Renderer/preload 无控制面，packaged build 永不可达。标准 32/32 与专项 3/3 使用独立 Electron 进程，环境不互相污染。
- **该 Research/Watcher 批历史最终复核**：Persistent Watcher Main/IPC **3/3**、Network Boundary **13/13**、Watcher Health **4/4**；完整 `npm test`、Electron-enabled `npm run verify`、标准强制 Electron **30/30** 全部重跑通过，独立复核 **P0=0、P1=0、P2=0**。`npm run verify:full` 已串联标准 30 阶段与 watcher 3 阶段；当前总链见本文顶部。
- **更早 Graph 性能批全量门禁｜历史证据**：完整 `npm test` exit 0；沙箱外 Electron-enabled `npm run verify` exit 0（含真实 DOM sanitizer **13/13**）；当时受控强制真实 Electron 从第一阶段顺序运行至结束 **26/26**。首次 Front Matter 超时后，后续三次该阶段均通过；两次中途失败分别是不同 Graph 筛选的单次 **265.2ms/116.4ms > 100ms** 性能抖动，最终同源码全链通过。未发现重复 watcher 或新增 Renderer Graph 负载，不据此重写已签字 Graph；当前总链见本文顶部。
- **迁移诊断回归**：Legacy migration **12/12** 新增动态证明 `editor.md → edit.md` 文件名迁移与 `edit.md` Front Matter v0→v1 reviewed ChangeSet 是两条独立链；Electron 超时现在会附带 Changes status/button/mode 诊断，防止再次只得到无上下文超时。
- **该批发布状态（历史）**：Research Accuracy v1 产品链已签字；0.0Y 的双-helper ad-hoc App/ZIP 当时按该批源码重建并验证，但禁止分发。当前 npm Preview、真实作者、账户、许可证与矩阵门禁见本文顶部当前里程碑；Developer ID/公证只属于未来独立 App 路线。

0.0AB 当时的 App/ZIP 与该批源码一致但仅为 ad-hoc 本地证据，**禁止分发**。历史 `259/259`、`312/312`、`335/335` 只对应旧快照，不可作为当前发布签字；当前状态见顶部当前里程碑。

### 0.2 2026-07-22 第八次收口的历史停点（已被第九次 Graph 签字覆盖）

| 范围 | 作者实现与运行证据 | 独立复审结论 | 下一轮状态 |
|---|---|---|---|
| localized edit / Plan / 普通 Changes | strict localized edits、stopReason 门禁、模型后与应用前 revision 复核；普通 Changes 双文件真实 Electron 通过 | 已完成复审，P0/P1/P2=0 | 保持，不重做 |
| Graph PRD 合规 | 作者纠错、Issue→Changes、三类补充 Issue、筛选语义、项目切换与异步所有权守卫均已落地；14 组 Graph 脚本通过 | P0=0、P1=0；仅保留非阻塞 P2 | 扩展验收已于第九次收口签字；仅保留顶部两项非阻塞 P2，不重开主链 |
| Chat project/file/selection | selection 必选、完整 request token/guard、正文 H1 Source locator、三层 scope 与可点击 Chip；强制 Electron 20/20，reviewer 另跑两轮各 20/20（合计 40/40） | **原 3 项 P1 已关闭；P0=0/P1=0/P2=1** | 保持主链；P2 仅补旧 preflight chips 主动清空 |
| Chapter 生成/整体重写 | strict plan/block、多区块生成、Main 本地组装、完整 session/request/pending 所有权与 origin capability 回收；Electron 应用/撤销通过 | **原 2 项 P1 已关闭；P0=0/P1=0/P2=1** | 保持主链；P2 仅继续固化部分 no-op/provenance-invalid 运行态测试 |
| Onboarding v2 独立底座 | strict metadata-only service、一次性 capability store、authentic-store 原子 batch 均已落盘；收口复跑 **22/22、15/15、22/22** | 动态 admission、TTL/eviction 对账与 rollback cause chain 已签收 | 已签字；下一轮不得重做 |
| Onboarding v2 Main/preload | v2 route、review/no-op token、完整 `edit.md` apply 后铸 token、single-flight、Renderer epoch 与生命周期精确清理均已落盘；生产 Handler **11/11**、定向集成 **14/14** | **P0=0、P1=0、P2=0** | 已签字；保持契约，不重写 |
| Onboarding v2 Renderer | exact v2 request、独立 confirmation mode、committed-warning 真相、双授权 all-settled、dynamic 主链接入和 destroy/deferred/rAF 守卫均已落盘；state **8/8**、UI **11/11**、dynamic **12/12** | 第二轮独立复审 **P0=0、P1=0、P2=0** | 自动化与当前源码 App 人工体验均已签字 |
| Onboarding v2 fixture/API/Electron | strict malformed→人工重试→第一次只改 edit→第二次原子建文件；冲突零部分写入、终态 token、迁移/no-op 均有动态覆盖 | 三文件独立复审 **P0=0、P1=0、P2=0**；强制真实 Electron **20/20** | 自动化签字；真实 API 本轮未重跑 |
| Research→Changes v1 | Main-owned canonical card/run、identifier-only handoff、只读 provenance、ACK/TTL/apply lease/residual 与 committed-warning 生产事务均已落盘；Research 12/12、handoff 15/15、transaction 11/11、integration 12/12、Renderer 13/13 | 最终独立二审 **P0=0/P1=0/P2=0**；0.0AB 当时总链为 Electron 35/35，当前见顶部当前里程碑 | 产品链与 committed-warning 动态故障边界均已签字 |
| Inline Rewrite / Plan strict（历史基线） | Inline 当前源码 App 已完成预览零写入、拒绝、重载、接受、History 与 undo；Plan 的旧文本 JSON 边界当时为 service **19/19**、handoff **11/11** | 该行只记录 2026-07-23 历史签字；真实作者晚位数组失败已使 Plan 生产协议迁移到 0.0BU 工具 input | Inline 保持签字；Plan 当前状态只看顶部与 0.0BU |

Onboarding v2 独立底座的权威文件为：

- `src/main/project-onboarding-v2-service.js`
- `src/main/project-onboarding-handler.js`
- `src/main/onboarding-capability-store.js`
- `src/main/onboarding-batch-service.js`
- `tests/verify-v0-project-onboarding-v2.js`
- `tests/verify-v0-project-onboarding-handler.js`
- `tests/verify-v0-onboarding-capability.js`
- `tests/verify-v0-onboarding-batch.js`

跨层接线还修改了 `main.js`、`preload.js`、三个 Renderer 文件，以及 integration/UI/state/dynamic、fixture/API/Electron 测试。第八次收口当时的源码完整 `npm test` exit 0；沙箱外完整 `npm run verify` exit 0（含真实 DOM sanitizer 13/13）；强制真实 Electron E2E **21/21**。当前最终证据见本文顶部的 **35/35**。

### 0.3 阶段复盘与恢复原则

- **已经独立签字的主链**：localized edit、Plan→Changes、普通 Changes、Graph 核心，以及 Chat/Chapter 的本轮 P1 修复均已完成独立复审；Chat 的 preflight 生命周期产品缺口也已关闭，不应在下一轮被重写。
- **Chat/Chapter 保留项已清零**：Chat 三条动态失效入口及 Main 权威取消竞态、Chapter no-op/provenance-invalid 均已关闭；两条链最终独立复审 P0/P1/P2=0。
- **Onboarding v2 自动化产品链已经签字**：service、capability、batch 为 22/22、15/15、22/22；Main/preload 当前为 14/14；Renderer state/UI 为 8/8、11/11，dynamic 已随 0.0T 扩展为 25/25；0.0AB 当时完整 verify 和强制 Electron 35/35 均通过，当前总链见顶部当前里程碑。
- **Onboarding v2 当前源码 App 人工体验已经签字**：隔离六章项目中，故意 malformed JSON 后十项回答保持且出现显式“重新整理 edit.md”；重试后提交前 `edit.md` SHA-256 保持 `28a5c89…`，首次接受后变为 `5f8872a…` 并在磁盘第 13 行出现 `E2E 项目卡已确认写入`；两个初始文件始终未创建；提交前后合法 `edit.md` 顶部均未显示“需修复”。本次使用本地确定性 AI fixture，不等于真实 API/作者验收。
- **Main/preload 的诚实提交语义已经固定**：post-commit bookkeeping 或 tree refresh 失败仍返回 `ok: true`、权威 `files` 与 `refreshRequired`；Renderer 会明确提示已创建、需重开且不要重复确认。
- **独立复审已经关闭 Renderer、fixture 与 Main 动态测试链**：Renderer 第二轮及 fixture/API/Electron 三文件复审均为 P0=0、P1=0、P2=0；Main Handler single-flight 与 navigation lifecycle 最终复审 P0=0、P1=0、P2=0。
- **Research→Changes v1 产品链与异常边界均已签字**：`../docs/RESEARCH-CHANGES-V1-CONTRACT.md` 已落地；committed-warning 生产事务动态覆盖真实磁盘/History、residual、TTL、stale、回滚与 undo，最终独立二审 P0=0/P1=0/P2=0。强制 Electron 已覆盖 reject-only、late-open A→B 及 Research→Changes→History/undo。
- **Inline Rewrite 产品链已经签字**：当前源码隔离 App 已完成预览零写入、拒绝、重载、接受后磁盘/History 同步与 Safe Undo；本次本地确定性 provider 不等于真实 API/作者验收。
- **Plan Strict v1 历史文本基线**：2026-07-23 的 `end_turn`/单文本 strict JSON 曾完成独立复审，但已被真实作者晚位数组失败推翻为生产生成协议；当前只接受 0.0BU 的单一 `submit_project_plan` tool input，详见顶部与合同现行章节。
- **该历史批当时的下一阶段入口（已完成并被取代）**：先完成 Image Review v1 独立复审，再补真实 `sk-api-`/作者证据、干净打包与发布复审；当前入口只看本文顶部。
- **证据纪律**：本地 Git 历史从 2026-07-26 V0 基线开始；恢复时必须同时核对本文、`git log` / `git diff`、磁盘当前文件和当次可复现测试结果。任何新的通过数字都要写明命令、覆盖范围和是否使用真实 Electron/真实 API。
- **顺序理由**：三级 AI 协作与 Graph 主链均已签字；真实 API/作者价值和发布门禁现在是最早仍开放的产品验收。

### 0.4 Renderer 交叉复审四项缺口（已关闭）

1. **已关闭｜committed warning**：磁盘已提交时保持“文件已创建”真相，展示权威路径、Main 刷新异常、需重开和不要重复确认；不进入普通成功或零部分创建路径。
2. **已关闭｜双授权回收**：review capability 与 confirmation token 分别启动并以 `Promise.allSettled` 收口，任一同步或异步失败不阻断另一项释放。
3. **已关闭｜dynamic 主链接入**：脚本计数固定为 `test=1`、`verify=1`、`preverify=0`、专用命令 `=1`。
4. **已关闭｜destroy/deferred/rAF**：销毁后迟到结果不调用 `onComplete`、不重渲染，排队 rAF 不夺焦点；动态对抗测试已覆盖。

## 1. 今日结束时的工程事实

### 1.1 已接入主流程

- **Phase A 本地项目地基**：普通 Markdown 文件夹、`edit.md`、原子保存、revision、Watcher、Front Matter 诊断、显式冲突处置和项目内 recovery。
- **项目 / 文件 / 段落三级工作区**：文件树、多标签、preview/pin/dirty、selection/scroll 恢复、Inline Diff、ChangeSet、撤销及安全文件生命周期。
- **项目建立向导与 `edit.md` 共创**：Onboarding v2 自动化产品链与人工 App 三项体验均已签字。生产源码使用 strict metadata-only、第一次只改 `edit.md`、第二次确认才原子建文件；0.0AB 当时的 ad-hoc App/ZIP 已重建但禁止分发，当前发布状态见顶部当前里程碑。
- **权威 Context 与右侧协作栈**：Main 有界解析引用，`edit.md` 真实进入模型上下文；Chat / Plan / Context / Changes 已接入。Chat 的 selection 必选、同项目并发 request token、Inspector/Chip 所有权与正文 H1 Source locator 已完成修复并独立签字。
- **完整 Chapter 生成/整体重写**：Main 先生成严格区块计划，再逐块生成并本地组装一个整文件 ChangeSet；支持空白章节、`end_turn`、只读依赖复核和历史撤销。Renderer 现绑定 project/target/instruction/context/pending，所有异步边界复验所有权并按 origin 回收迟到 capability；原 2 项 P1 已关闭。
- **Plan→Changes v2**：Plan 保存 Main 权威目标 revision；Renderer 只交接 `planId/taskId`。提案使用独立 `pc_*` capability，依赖漂移、同内容提案碰撞、A/B 任务竞态与脱离 Plan 均 fail closed；真实 Electron 已证明锁定目标经人工接受后才落盘。
- **逐块 Changes 审阅**：Main 生成稳定 hunk ID 与结构化 Diff；默认全部 pending，支持逐块/整文件接受、拒绝、重置、部分提交、残留提案、拒绝审计和顺序撤销。`edit.md` 始终强制整文件决策；提交期间锁定全部审阅控件。
- **一致性 Graph v2 与来源地基**：Node / Edge / Evidence / Issue v2、稳定锚点、人物/变量/时间建模、作者纠错、结构化 Issue→Changes、补充 Issue 类型、筛选/搜索、stale Evidence 和异步项目所有权均已接入；历史真实 Electron 已覆盖 cold UI、AX/键鼠、failure-live、最小窗口、300 文件/1279 节点性能、重启与 A→B。后续韧性批已补完整语义权威、不可变快照和动态 supersede，独立复审 P0/P1/P2=0；当前源码 Electron 复跑边界见本文顶部。
- **Research 闭环与 Changes 交接**：Renderer 只向 Main 传问题/source IDs，handoff 只传 `cardId`/targets；Main 重建 Claim / Source / Boundary、来源 revision/quote/locator、`edit.md` 与 target dependencies。专用 Changes 模式预览零写入，人工决定后才应用，History/undo 保留有界 provenance。
- **`image-01` 插图闭环**：Main 校验 PNG/JPEG、解码尺寸/比例并安全落盘；Renderer 必须收集评分与明确终态。插入写 Markdown、保留零正文修改、废纸篓只移动 token 所属资产，项目切换前必须结算。
- **Author Evidence Metrics v1**：既有八字段指标继续记录 image 生成耗时/失败与接受/丢弃；独立 Image Review 证据只记录评分、三类终态和可选费用。配图面板显示项目累计平均分及插入/保留/废纸篓计数，两套文件都禁止正文、Prompt、模型回答、Key、路径与远端错误。
- **Onboarding 指标/Watcher 握手修复**：成功生成指标只在内存保留固定八字段，等 edit.md 审阅或初始文件确认进入终态后再按顺序落盘；结构失败与人工重试仍即时记录。这样不削弱 filename-less 外部变化的 fail-closed 策略，也不会让 `.writcraft/metrics.json` 的内部原子写误伤活跃 confirmation token。
- **Electron 外部变化与 Graph 性能修复（历史过程）**：该批曾以 `aiContextGeneration` 与 `externalQueue` 收敛作为临时等待；0.0Q 已统一替换为 Main exact barrier。Graph 对同值筛选短路，并复用已渲染的完整 SVG 场景，返回 300 文件全图仍守住 100ms 交互门槛。
- **Metrics origin 项目竞态修复**：inline / Changes / Plan 在操作创建时捕获 `originProjectInstanceId`；Renderer 先要求 current instance 等于 origin，Main 再做 instance gate。A 项目发起、切换到 B 后延迟返回的成功/失败事件都不会落入 B。
- **Main 网络最小边界**：文本只允许 `api.minimaxi.com/anthropic/v1/{models,messages}`，图片只允许 `api.minimaxi.com/v1/image_generation`。Renderer 由 CSP `connect-src 'none'` 与 session 的 HTTP(S)/WS(S) 拦截双重断网，所有浏览器权限与设备权限默认拒绝。
- **AI 生命周期地基与当前边界**：Main 的生成 IPC 已绑定可信 sender、origin project instance 与 mutation generation；Chat/Chapter、Onboarding v2、Research→Changes、Inline Rewrite 与 Plan 生成均已达到 fail-closed 契约并通过独立实现复审。
- **Watcher 内外源隔离**：Main 成功提交会登记 Markdown revision 与父目录状态；相同 revision 的 fs.watch/poll 回声直接消费，不再二次推进 AI generation 或刷新 UI。引用双阶段导入使用按 root 隔离的 mutation lease；native watcher 同步/异步资源错误都会降级到有界 polling。
- **真实 DOM sanitizer**：恢复 HTML 与 AI Markdown 共用严格 allowlist；删除 metadata/form/media，解包 SVG/MathML/custom namespace，限制 URL、图片类型、尺寸和节点总量。受控执行环境的 GUI 沙箱内启动曾因 `SIGABRT` 失败，这是 GUI 沙箱限制；同一专项在沙箱外真实 Electron 中 **13/13** 通过。
- **稳定应用数据目录**：正式数据固定在 macOS `Application Support/WritCraft`；只迁移验证通过的 Key 配置和最近项目记录，no-clobber、原子写入并收紧目录/文件权限。开发 E2E 使用显式隔离 profile，不再与真实用户配置握手。
- **可解释 API 握手**：打开设置不自动联网；保存 Key 后检测一次，也可由用户显式点击“检测连接”。Main 只向 Renderer 返回 Key 类型、稳定状态、模型可用性与延迟，不返回 Key、远端 body 或未知异常。

### 1.2 已验证的长文与 Electron 路径

- 离线 long-form service E2E 覆盖真实目录、`edit.md`、6 章、来源、原子保存、章节提案、三文件 ChangeSet/撤销、图谱增量分析和工作区恢复。
- 0.0AB 当时在 `WRITCRAFT_E2E_FORCE=1` 下完成真实 Electron BrowserWindow E2E **35/35**：新增普通 Markdown 项目回收区列表/恢复及磁盘字节/树证明；图片、Chat、Graph、Research、Changes 与重启旅程继续通过，正文和评审证据保持合同边界。
- 0.0AB 当时的 `npm test` 与非沙箱 `npm run verify` 均 **exit 0**；强制 Electron **35/35**、Persistent Watcher **3/3**。当前证据只看顶部当前里程碑。
- 真实 MiniMax 验收脚本只使用合成项目数据并默认断网；显式门禁后，`/models`、最小 `/messages`、项目卡提案和 Research 均成功，正文磁盘保持零修改。0.0AC 又以 Coding Plan Key 完成真实 `image-01` 能力/解码门禁；质量、费用和采纳仍待作者旅程。

### 1.3 必须保留的产品语义

- Research 的 **A–D 是用户对来源类型/证据强度的元数据声明**，不是 WritCraft 对内容真伪、方法质量或权威性的背书。
- revision / exact quote 重验证明“此刻仍指向用户选定的原文”，不证明原文事实为真。用户必须阅读 Claim / Source / Boundary 并人工确认后才能进入 Changes。
- `image-01` 生成成功只意味命中格式、安全落盘且可预览；不得在用户明确点击前插入正文。
- 自动化中的 Research / image 调用使用 stub，不等于真实 MiniMax API 质量、账单、延迟、限流或故障行为已验收。
- “文本握手成功”“模型返回可解析项目卡 JSON”“图片 API 可用”是三个独立结论，不得用其中一个替代另外两个。Key 前缀不能替代 provider 能力判断；`image-01` 作者质量/费用验收可使用现场具备权限和额度的 `sk-cp-` 或 `sk-api-`。

### 1.4 2026-07-19 旧 v1 手动验收缺陷（2026-07-21 已缓解）

以下问题均已在旧 Onboarding v1 链路中修复并进入真实 Electron 回归；它们只是当时的 UX/容错缓解，**不能作为后来 Onboarding v2 安全契约的实现证据**：

- **项目卡结构化输出**：严格候选提取、字符串感知 trailing-comma 修复、512 KiB 输出上限、64 KiB 修复输入上限、最多一次模型修复；最终失败保留全部答案并显示“重新整理 edit.md”。
- **最近项目隔离**：普通自动恢复拒绝 `os.tmpdir()` 下项目；仅未打包且 Main 启用 E2E fixture 时显式允许临时根。用户主动“打开项目”不受影响。
- **Changes 提交语义**：固定显示“当前仅为预览，尚未写入项目”，主 CTA 为“提交 edit.md 审阅决定”；用户接受后才写盘，成功后从磁盘强制重读并聚焦 `edit.md`，避免同文件快速打开留下旧 revision。
- **Front Matter 权威校验**：生成提案进入 ChangeSet 前强制 `schema: writcraft.edit/v1` 且无 error；旧 v0 迁移保留未知字段与正文，只生成审阅 Diff。
- **诊断与迁移入口**：顶部展开稳定错误码、真实行号和原因；可安全迁移时提供“生成修复提案”，纯 warning 不再生成空 Diff，结构歧义要求先按行手动修复。
- **两阶段部分提交**：`edit.md` 已写入而初始文件部分失败时，UI 明确显示已提交状态，Main 仅保留剩余建议，用户可只重试剩余文件或结束，不会重复应用失效 ChangeSet。

本轮诊断同时确认：右侧看到的内容仍是内存中的待审阅 ChangeSet，磁盘 `edit.md` 没有被静默覆盖。修复不得破坏“AI 只生成提案、用户明确确认后才写入”的产品安全语义。

Onboarding v2 已取代上述“容错解析完整 `editContent` + 部分创建续跑”协议：当前协议是 strict、metadata-only、Main 确定性合并，并保证批量创建 all-or-nothing。旧 v1 的已通过回归只保留为迁移/兼容证据。

## 2. 验证快照

2026-07-22 Chat/Chapter P1 关闭后、Onboarding v2 跨层修改前的历史基线证据：

- 作者实现侧当时运行 `WRITCRAFT_E2E_FORCE=1 npm run e2e:electron`：**20/20 stages passed**；覆盖普通 Changes 双文件、Chat 文件/项目/选区三层作用域、可点击 Context Chips、分阶段 Chapter 的整文件审阅/应用/撤销，并保留项目卡、Research、metrics、Watcher、image、restart 与 0 renderer HTTP(S) 链。
- 当时完整 `npm test` **exit 0**、`npm run verify` **exit 0**，强制真实 Electron E2E **20/20**。Day 4 已移除过期文案字符串假设；这些数字不覆盖本次新增的 Onboarding v2 在制代码。
- Chat：原 selection 可排除、同项目文件切换/并发竞态、Front Matter 标题 locator 三项 P1 均已关闭；独立 reviewer 在修复后另跑两轮，各 **20/20**、合计 **40/40**，最终 **P0=0/P1=0/P2=1**。唯一保留 P2 是 scope/selection/editVersion 变化时旧 preflight chips 不主动清空。
- Chapter：该历史批次关闭了在途请求失效与 pending/no-op capability 所有权两项 P1；当时 Proposal Transaction **19/19**、最终 **P0=0/P1=0/P2=1**，遗留 no-op/provenance-invalid 测试固化。该历史 P2 已在 2026-07-23 的 **0.0D** 中关闭，当前为 Proposal Transaction **23/23**、最终复审 P0/P1/P2=0。
- API Key 握手专项：**9/9**；Key 配置 **10/10**；稳定 userData **8/8**；真实 GUI 显式检测连接成功显示 MiniMax-M3 和 8 个可用模型，设置面板打开本身不发请求。
- 真实 MiniMax 合成验收：`models` 约 1.4s；最小文本约 10.2s；项目卡约 19.4s，输出 1 个 edit.md ChangeSet 与 3 个初始文件建议且磁盘零修改；Research 约 2.7s，返回 1 张可验证证据卡并安全修复唯一 quote 坐标。数据为合成内容，不是作者样本。
- image-01 当时诊断（**已被 0.0AC 推翻**）：旧产品曾按 Coding Plan 前缀在联网前返回 `IMAGE_KEY_UNSUPPORTED`。0.0AC 查明官方能力取决于套餐/额度，并以真实 `sk-cp-` 合成调用证明可用；此处只保留为错误假设的历史记录。
- Changes 独立复审：首轮发现 post-commit 树刷新假失败和提交期间控件竞态两项 P1，及 residual Plan provenance 一项 P2；均已修复。最终定向 **40/40**，P0/P1/P2 为 0。
- 该历史停点的 Graph v2 独立复审：14 组脚本全绿，包括 Consistency **21/21**、Graph Index **11/11**、Corrections **15/15**、Filter **12/12**、Workbench **11/11**、Issue State **10/10**、Graph Handoff **8/8**、Integration **6/6**、Long-form **8/8**、Large Project **5/5**；额外遍历 840 组筛选组合，P0=0、P1=0。当前最终签字证据见本文顶部。
- API 握手独立复审：发现并关闭 model ID 嵌入式 Key、真实验收报告 provider model、损坏配置恢复入口三项 P1，以及图片 408/1039 错误分类两项 P2；攻击性复现与修复后复审均无残留 P0/P1/P2。
- Main 网络专项：MiniMax text **14/14**、network boundary **11/11**、image generation security **13/13**；全部使用 stub fetch，0 真实网络。
- Renderer DOM 安全专项：受控执行环境的 GUI 沙箱内运行因 `SIGABRT` 无法启动 Electron，确认属于 GUI 沙箱限制而非 sanitizer 断言失败；同一命令在沙箱外真实 Electron 中 **13/13** 通过，覆盖危险元素/事件、DOM clobbering、SVG/MathML namespace、危险 URL、远程/SVG 图片、二次解析与超量节点 fail-closed。
- Watcher 专项：**14/14**，包含 native 异步/同步资源错误消费并降级 polling；真实 Electron 另覆盖完整 1200ms polling 周期与 1700ms 在途 AI 的自身保存回声竞争时序。
- Metrics 专项：service **11/11**、Main/preload integration **6/6**、renderer **12/12**；包含 A→B 后延迟成功/失败不落入 B 的动态测试。
- Research 专项：service **12/12**、integration **8/8**、Sources project-race **2/2**，并且 use-time revision/quote 重验只允许交给可审查 Changes。
- image-01 专项：generation security **13/13**、renderer **8/8**；自动化为 stub fetch，0 真实网络。
- `preverify` 已把 Research、image-01、metrics 与协作栈纳入验证链；Onboarding v2 跨层修改之前的完整 `npm run verify` 已 exit 0。

第四次收口新增证据：Onboarding v2 service **22/22**、capability **15/15**、batch **22/22**；Main/preload **13/13**；Renderer state **8/8**、UI **11/11**、dynamic **12/12**。Renderer 第二轮及 fixture/API/Electron 三文件独立复审均为 P0=0/P1=0/P2=0；**该历史时点** Main 还保留两个 P2 测试增强项，现已由 0.0F 关闭。完整 `npm test`、沙箱外 `npm run verify` 均 exit 0，强制真实 Electron **20/20**。

第五次收口新增当前源码 App 人工证据：malformed JSON 保留回答并显式重试；第一次接受前磁盘零写入，接受后 `edit.md` 真正变更且重新读取；初始文件保持零创建；合法 `edit.md` 没有“需修复”。

第六次收口新增 Research→Changes v1 当时源码证据：Research service **12/12**、handoff service/store **13/13**、Main/preload integration **12/12**、Renderer **13/13**；History **14/14**、ChangeSet review **15/15**、Pending store **11/11**。独立实现复审 **P0=0/P1=0/P2=1**；`npm test` 与沙箱外 `npm run verify` 均 exit 0，强制真实 Electron **20/20** 动态覆盖 stale/rerun、late-open A→B、accept、reject-only、History provenance 与 undo，Renderer 0 HTTP(S)。该批源码 App 隔离六章人工旅程中，预览前 target SHA 为 `0153e224…`、`edit.md` 为 `28a5c89…`；应用后只改 target 为 `e008694d…`，来源/`edit.md` 不变；History 为 v3 `research_card`，undo 后 target 恢复 `0153e224…`。

第八次收口新增当时源码证据：Inline 隔离 App 人工完成预览零写入→拒绝→重载→接受→History→Safe Undo；Plan Strict v1 service **19/19**、handoff **11/11**，独立复审 **P0=0/P1=0**。复审期间关闭模型路径回显、原型链信封继承、最多 480 个目标导致约 2.4 GiB 快照压力，以及超大最终 provider request 四项缺口。该批 `npm test`、Electron-enabled `npm run verify` 均 exit 0，强制真实 Electron **21/21**。

第十次收口新增当时源码证据：真实 API acceptance 离线合同 **15/15**、0 网络；Metrics service/integration/Renderer 当时为 **13/13、6/6、17/17**，Onboarding dynamic **13/13**。首轮强制 Electron 在外部冲突文件删除后立即重铸 confirmation，延迟 watcher 事件推进 generation，稳定触发 `STALE_CONFIRMATION`；该历史批曾等待 `aiContextGeneration` 与 `externalQueue` 收敛，现已由 0.0Q Main exact barrier 取代。Graph 当时以完整 SVG 场景复用关闭 300 文件筛选返回全图超过 100ms 的性能失败。当时最新源码 `npm test`、Electron-enabled `npm run verify` 均 exit 0，强制真实 Electron **26/26**；这些历史绿灯已被第十一次收口的 Metrics 复审 P1 推翻为“不可签字”，不得继续当作 Metrics 最终证据。

第十一次收口暂停快照（历史，已被本节最终签字覆盖）：Metrics exact-operation 与正常切项前结算已经验证有效，但当时独立复审为 **P0=0/P1=1/P2=1，不可签字**。待关闭的同源缺口是：pending Onboarding review 的文件生命周期失效与手动丢弃没有可靠 terminal settlement；capability 已消费但指标失败时再次切项可能重复消费并卡死；`edit.md` 已提交后若刷新/进入 confirmation 抛错，accepted 指标可能遗留。必须补四条动态异常测试、复跑全量 Node/verify/强制 Electron，并经独立复审 P0/P1=0 后才能覆盖本段。

第十一次收口第二轮复审（历史，已被下一段最终签字覆盖）：上述四条指标结算缺口及动态测试已关闭，Onboarding dynamic 暂增至 **19/19**；当时复审仍为 **P0=0/P1=2/P2=1，不可签字**。剩余问题下沉为 capability 生命周期：并发双击丢弃/切项必须共享同一个 in-flight release，禁止重复消费非幂等 review capability；Main 已铸造 confirmation 后若刷新或进入 confirmation 失败，必须显式释放 exact token，同时保留 accepted 指标。新增两条并发/异常对抗测试并完成第三轮复审前，先前全量绿灯仍不计作最终 Metrics 证据。

第十一次收口最终签字：同一 Onboarding review 现在用共享 `releasePromise` 合并并发丢弃与项目切换，成功后禁止二次消费、失败后允许安全重试；提交后刷新/confirmation transition 异常会用原项目和 exact token 显式清理，清理失败则阻断新向导与切项直至重试成功，同时原 operation 仍诚实记录 `accepted`。Onboarding dynamic **22/22**、Metrics Renderer **18/18**、Workspace **19/19**、UI **11/11**；最终源码 `npm test`、Electron-enabled `npm run verify` 均 exit 0，强制真实 Electron **26/26**，第三轮独立复审 **P0=0/P1=0/P2=0，可签字**。非阻断后续增强：可增加“首次 review capability release 失败、第二次成功”的独立动态用例，但不重开本轮主链。

准确结论是“Chat 单轮 scope/context、Main-owned 最近对话、超长项目卡分区披露、普通 Markdown 项目回收区与 Chapter 主链已经签字；Onboarding v2 自动化产品链与人工 App 三项体验均已签字；0.1.1 Developer Preview 已公开”。不准确的结论是“fixture 人工签字等于真实 API/作者价值”、“0.1.1 已发布等于完整 V0、稳定版或真实作者验收完成”。0.0AB 当时的 App/ZIP 只与该批源码一致且仅是本地证据；当前发布事实见顶部当前里程碑。

## 3. 当前产品能力矩阵

状态：✅ 已接入且有自动化/行为证据；🟡 已实现但待人工 GUI、真实 API 或安全复审；⬜ 未完成。

| 模块 | 状态 | 当前事实 |
|---|---:|---|
| Electron 安全壳、本地项目、保存/Watcher 与冲突恢复 | ✅ | 安全边界、路径、revision、外部修改与草稿/冲突恢复有自动化证据；普通 Markdown 回收区由独立 0.0AB 事务合同覆盖 |
| 三级工作区与右侧协作栈 | ✅ | Chat 三层 scope、selection 必选、并发所有权、可点击 Chip、动态失效与 Main 权威取消均已接入；0.0Z 增加项目卡分区披露，0.0AA 增加 Main-owned 最近对话与可见重置 |
| Chat 最近对话摘要 / 多轮连续性 | ✅ | Main 内存保留最多 6 个已完成轮次，绑定 owner/navigation/project/root/generation；新提交抢占、显式新对话、同项目重开和上下文失效均有真实 Electron 证据 |
| 项目卡 → edit.md → Changes 提交闭环 | ✅ | Onboarding v2 生成、预览、确认落盘与第二阶段建文件已签字；其中 **20/20** 是该链历史专项 Electron 证据，0.0AB 当时总链为 **35/35**，当前见顶部当前里程碑 |
| 超长 edit.md 的章节化上下文与 Inspector 披露 | ✅ | Chat/Context 已按标题整章编译、四类硬约束优先、Manifest 逐章披露并 revision-safe 定位；必需章节或恶意目录超限 fail-closed，其他 AI 模式保持既有合同 |
| 普通 Markdown 回收区恢复 UI | ✅ | Explorer 列表/刷新/单项恢复、窄 IPC、opaque token、watcher barrier、native journal recovery、冲突与替换 fail-closed 均已签字；真实 Electron 35/35 |
| Chapter 生成/整体重写 | ✅ | strict plan/block、整文件审阅、撤销、完整异步所有权、no-op/provenance/result/capability 运行态门禁均已接入；最终复审 P0/P1/P2=0 |
| Changes 分块审阅与历史 Plan→Changes 安全链 | ✅ | Changes 默认 pending、逐块/整文件决策、residual、审计/撤销和目标 revision 锁定仍有效；Plan→Changes 只算历史安全证据，不是现行入口 |
| 结构规划 / 写作导航 | ✅ | 结构规划与 Navigation 生成/定位/帮助度已签字；统一写作任务流的一次点击、正文内 Diff、接受与 Safe Undo 已由 exact candidate `e8b9588` 完成作者验收 |
| Graph v2 核心与扩展验收 | ✅ | 300 文件/1279 节点、纠错/stale/failure live、AX/键鼠、布局/性能、重启/A→B 均有行为证据；韧性批关闭语义权威、不可变快照与异步所有权，复审 P0/P1/P2=0；0.0AB 当时总链为 35/35，当前见顶部当前里程碑 |
| Diagnostic Preview / Export | ✅ | 设置页精确预览、递归脱敏 allowlist、token-only IPC、原生保存和不可覆盖 0600 写入均已接入；Service 13/13、Handler 10/10、Renderer 7/7、真实 Electron 可见旅程通过 |
| 来源、PDF、脚注 | ✅ | 本地证据地基和可审查建议已接入 |
| AI metrics | 🟡 | 真实 GUI 已验证项目内记录、聚合与落盘；项目切换隔离有专项动态证据，仍待真实作者样本 |
| Research / A–D 溯源 | ✅ | Main-owned Research→Changes v1 与 committed-warning 技术边界已签字；作为独立高级能力保留，不再是 0.1.2 默认作者旅程或当前人工验收待办 |
| image-01 插图 | 🟡 | Coding Plan 真实合成调用、解码尺寸/比例和零正文插入已通过；安全审阅/废纸篓链保持签字，仍待真实作者质量、采纳、费用/限流样本 |
| 6→7 章 Electron E2E | ✅ | exact candidate `e8b9588` 强制真实 Electron 37/37；合格真实作者项目已完成受影响的统一任务最短链 |
| 10 名作者内测与 Continue 指标 | ⬜ | 尚无真实样本，不得做 Go/No-Go 结论 |
| npm Developer Preview | ✅ | `preview: 0.1.1`、`latest: 0.1.0`；公网 shasum 匹配、隔离安装 2/2，exact GitHub `v0.1.1` prerelease 已公开 |
| 独立 macOS App 发布 | ⬜ | 当前不是首发路线；若未来启用，仍需 Developer ID、hardened runtime、公证和 Gatekeeper |

## 4. 后续 TODO（严格顺序）

### RM-1.2 / 0.1.2：当前唯一目标

- [x] 由作者显式指定满足合同的真实项目，完成只读预检与隔离副本；0.0AQ 的正式事务证明源不变，fresh 副本已合格创建并在当前 App 打开。
- [x] 项目卡、Inline、Chapter、结构规划、Navigation 原文定位/帮助度及旧 Changes 技术闭环均已完成，不再重复；统一写作任务流的一次点击、同任务依据、正文内 Diff、终态、接受/拒绝与 Safe Undo 已由 exact candidate `e8b9588` 签收。
- [x] 复现并诊断作者项目 `Graph INVALID_CACHE`；0.0AN / `a72a179` 已提供不删除作者数据、不手工清缓存的可理解诊断、自动重建与失败恢复终态，最终独立复审 P0/P1/P2=0。
- [x] Inline 接受率、Navigation 帮助度与统一任务动作/可理解性已有真实作者样本；旧 Research 匹配判断不再补测。
- [x] 只修复验收中发现的 P0/P1 与决定阻断发版的 P2；统一任务 exact candidate `e8b9588` 已完成全量、真实 Electron 与独立复审，不插入 `0.2.0+` 功能。
- [ ] 完成真实 GUI `image-01` 质量评分与明确终态；不得把合成图片门禁或空 `image-reviews.json` 当作作者验收。
- [x] npm 登录已通过官方浏览器恢复并复核为 `houxyue`；registry 仍无 0.1.2。
- [ ] 针对最终候选重跑 audit、preview tarball、installed、完整回归/真实 Electron和独立复审；通过后仅发布 `preview`，保持 `latest=0.1.0`。
- [ ] 发布后同步 registry shasum、公网安装、Git tag/GitHub prerelease、文档、Git 与 Nowledge；所有者发布授权已于 2026-08-03 给出，无需再次索取，但不豁免前述门禁。

### P1：能力审计后的本地产品缺口

- [x] `edit.md` section-aware 上下文编译与 Inspector 披露：标题/围栏、硬约束优先级、双预算、整章语义、revision 绑定、有界 ledger、短文 parity 和 stale locator 均已实现；最终稳定性签字见 0.0Z。
- [x] Chat 最近对话摘要与多轮连续性：Main-owned bounded turns、项目/owner/navigation/generation 绑定、可见新对话、新提交抢占、同项目重开和 Inspector 披露均已实现，最终签字见 0.0AA。
- [x] 普通 Markdown 回收区列表与恢复 UI：窄 IPC、opaque capability、watcher barrier、Main exact-owner lease、native journal transaction、冲突/替换 fail-closed、Renderer 可见列表/单项恢复和真实 Electron 旅程均已由 0.0AB 签字。
- [x] 0.0AB 本地产品实现批已清零；0.0AC 只新增 npm 发布壳与 provider 能力纠错，不重开历史产品协议。

### P1：Chat/Chapter 独立复审阻断项（已关闭）

- [x] Chat：将 `selection` 与 `scope`、`project_prompt` 一样设为不可排除；Resolver 在策略过滤后再次确认精确选区完整进入模型。
- [x] Chat：preflight、LLM、Inspector/Chip 共用 request token；文件/revision/editVersion/selection/scope 漂移或后发请求会使旧结果失效。
- [x] Chat：Source 标题 locator 定位 Markdown 正文 H1，不再优先命中 Front Matter `title`；已有同名 YAML/Heading 点击回归。
- [x] Chapter：project/target/instruction/context/pending 与 transaction 绑定；每个异步边界复验，迟到 capability 按 origin 丢弃。
- [x] Chapter：旧 pending 阻止新 Chapter；no-op 与 review replacement 都不能清空/覆盖并发审阅，旧 finally 不干扰新请求 UI。
- [x] 独立复审后重跑完整 `npm test`、`npm run verify` 与强制 Electron E2E，均通过。

### P1：Onboarding v2 自动化与人工体验已关闭；随后迁移

- [x] Onboarding v2 独立底座：service 22/22、capability 15/15、all-or-nothing batch 22/22，均加入验证主链且各只出现一次。
- [x] Onboarding v2 Main/preload 定向契约：当前集成 **14/14**，覆盖 project switch/discard/residual/stale、post-commit token mint failure、batch commit 后 bookkeeping/tree refresh 失败仍保持 `ok: true` 与权威 `files`、独立 confirm/discard IPC，以及后续 watcher flush 边界。后续只需随总链做 Electron/回归，不重写契约。
- [x] **Renderer committed warning**：保留“磁盘已提交”真相，展示权威文件路径、Main 状态刷新异常、需重开项目及不要重复确认；动态对抗测试通过。
- [x] **Renderer 双授权 all-settled 回收**：`discardChanges` 同步或异步失败时仍执行 `discardOnboardingConfirmation`。
- [x] **验证主链接入**：dynamic 在 `verify` 恰好一次、`preverify` 零次；Renderer state/UI 为 8/8、12/12，dynamic 当前为 26/26。
- [x] **向导销毁后的异步焦点**：所有 rAF focus 回调执行时复核 `destroyed`；deferred `onGenerate → destroy → resolve` 已证明不调用 `onComplete`、不重渲染、不夺焦点。
- [x] Onboarding v2 fixture/API/Electron：完整 `npm test` 与沙箱外 `npm run verify` exit 0；**20/20** 是该链历史专项 Electron 证据，0.0AB 当时总链为 **35/35**，当前见顶部当前里程碑。它证明 malformed 保留答案且不自动修复、第一次确认只更新 `edit.md`、第二次确认才原子创建 Main 模板、冲突零部分写入且 token 终止。
- [x] **当前源码 App 三项人工复验**：隔离六章 fixture 中，Malformed JSON 后回答保留并可重试；第一次接受真实写入磁盘 `edit.md` 且第二阶段前初始文件零创建；合法 `edit.md` 顶部不显示“需修复”。
- [x] Research→Changes 产品链：建立 `writcraft.research-handoff/v1`，Main 按 card ID 重建 source revision/quote/locator，把来源绑定为只读依赖并进入 provenance；独立实现复审 P0/P1=0、全量 verify exit 0；**20/20** 是含 reject/A→B 的历史专项 Electron 证据，0.0AB 当时总链为 **35/35**，当前见顶部当前里程碑。
- [x] Inline Rewrite 自动化链：既有写入/恢复链保持签字；0.0BJ 新增必填作者指令 composer 与 exact request v2，定向 Context 15/15、Main 11/11、transaction 14/14、integration 7/7、Renderer 11/11，完整 test/批准 GUI verify 与最终 Electron 37/37 通过，第三轮独立复审 P0=0/P1=0/P2=0。
- [x] Inline Rewrite 当前候选真实作者旅程：第五副本已完成接受、独立拒绝与精确 Safe Undo，正文、History 和全项目 Markdown 摘要均回到操作前基线；项目卡与 Inline 均不再重跑。
- [x] 旧 Plan 的 named-tool 安全链保留为历史证据；九次真实零写入失败后，产品假设已由 0.0BY 正式关闭，不再运行 MiniMax canary。
- [x] 按 `WRITING-NAVIGATION-V1-CONTRACT.md` 完成结构规划/写作导航 Main、IPC/preload、Renderer、进度/取消/恢复、旧 Changes/Research 路由、完整专项和真实 Electron 技术验收；其后续公开双动作已由 RM-1.2 / 0.0CM 统一任务合同取代。

### P2：Chat/Chapter 独立复审保留的非阻塞测试增强

- [x] Chat：scope、selection、`editVersion`、Chat 重开与 workspace 权威状态变化会主动清空失效 preflight；request/phase 所有权保护新 preflight 与 actual。Chat 11/11、真实 Electron 28/28，最终独立复审 P0/P1/P2=0。
- [x] Chat 测试增强：Chat 重开、正文 collapsed selection 与 workspace invalidation 已各自进入真实 Electron；唯一问题/响应避免历史消息假阳性，Main `PROJECT_CHANGED` 先于 Renderer watcher 收敛的竞态也已动态关闭。
- [x] Chapter：no-op 与 provenance-invalid 已抽成生产复用分类器和动态测试；绑定完整 provenance、inner/outer capability 与唯一 file review，确认式回收并防重复 discard。Chapter 17/17、Proposal Transaction 23/23，最终独立复审 P0/P1/P2=0。
- [x] Onboarding Main：生产 handler **6/6** 动态覆盖并发、pre-model live authority、TTL、真实 Pending ChangeSet eviction 与项目/generation drift；rollback cause chain 显式锁定为 `ROLLBACK_FAILED → COMMIT_FAILED → force rollback`。完整 test/verify 与 Electron 28/28 通过，独立复审 P0=0/P1=0。
- [x] Onboarding 成本优化：同项目 single-flight 已确保并发空闲请求只产生一次付费模型调用；owner-only `finally`、Renderer navigation epoch 与页面生命周期 exact-project cleanup 已覆盖 await→mint 和 mint→IPC delivery 两侧竞态。Handler 11/11、Main/preload 14/14、完整 test/verify 与 Electron 28/28 通过，最终独立复审 P0/P1/P2=0。
- [x] Research→Changes committed-warning：生产事务 11/11 动态覆盖真实 apply/History、post-commit stale/TTL、residual put/finish/tree、reject-only、conflict、History rollback、旧能力防重放与 undo；最终独立二审 P0/P1/P2=0。
- [x] Plan Main handler 动态白盒：已抽出 `src/main/project-plan-handler.js`，实际 IPC 注册复用该 factory；Plan handoff 15/15 直接执行生产 factory，覆盖 rejected result、success cache、模型返回后的项目/generation stale 与异常→`projectFailure`，并逐项锁定 Main 十项依赖注入。独立复审 P0=0/P1=0/P2=0。

### P2：Graph 既有韧性缺口（代码与独立复审已关闭）

- [x] Graph：已补 deferred-promise 运行态回归，覆盖 A→B、persist 中切项和同项目后发 refresh 对旧 resolve/reject 的 supersede。
- [x] Graph：Graph Index 已从 Main 权威文件快照重建 canonical contribution，缓存和 injected analyzer 的 evidence/完整语义都必须精确匹配。
- [x] Graph：Renderer Graph/Node 已固化为有界 clone + recursive freeze；非法快照 fail closed，WeakMap 派生不再接受原地突变。
- [x] Changes/History：`history_failed_rollback_failed` 已进入 durable reconciliation/manual-recovery；Main/IPC/Renderer、两项人工恢复、同动作重试与真实 Electron 30/30 均已签收。

### 当前全链复验门禁（Changes/History 0.0J 已关闭）

- [x] 在最终 Graph 0.0I 源码上重跑完整 `npm test`，exit 0；所有 Graph 定向与独立二审通过。
- [x] 在同一最终源码上重跑 Electron-enabled `npm run verify`，exit 0，真实 DOM sanitizer 13/13。
- [x] 随后重跑 `WRITCRAFT_E2E_FORCE=1 npm run e2e:electron`，30/30。

### P1：Research Accuracy v1（已签字）

- [x] 判断事务在推进 mutation generation 前完成 active mutation、exact owner/READY lease 与 live authority 校验；无效、stale 或错误 owner 请求零 generation 副作用。
- [x] filename-less watcher 事件保持 fail-closed；metrics 原子提交前重验 source/card authority，提交后只允许 exact card 重绑。
- [x] watcher 持续重启失败进入 exact project instance/root degraded 门禁，阻止后续 AI、项目写入与 Changes apply；重新打开的新实例成功启动 watcher 后清除。
- [x] 关闭第三轮 degraded 旁路：Inline apply、legacy edit confirm、Graph Issue handoff、Inline reconciliation/clear 均在首个磁盘或私有 metadata 副作用前门禁；首次 legacy migration 无 currentProject 的既有流程仍可执行。
- [x] 修正同根重开：稳定 instanceId 不再使恢复成为 no-op；degraded 或 watcher 缺失时显式 restart，成功才清除门禁，失败继续锁定。
- [x] Renderer 只在 `recorded && handoffAvailable && evidenceChanged === false` 时解锁；recorded-but-locked 会禁用来源、判断与 Changes，并禁止旧卡片重试。
- [x] 最新定向套件通过：transaction 10/10、watcher health 4/4、Legacy migration 12/12、Inline integration 7/7、Graph Issue handoff 6/6、network boundary 13/13；此前 Sources UI 16/16、Sources race 5/5、Research Renderer 13/13、Metrics 18/18、Watcher 16/16、handoff 15/15、两组 integration 8/8 与 12/12 仍绿。
- [x] 将 reviewer 的真实 Main/IPC persistent-failure harness 固化进仓库；专项 3/3、标准 Electron 30/30、完整 test/verify 与最终独立复核 P0/P1/P2=0。
- [x] 完整 `npm test`、Electron-enabled `npm run verify` 均 exit 0；最终受控 `WRITCRAFT_E2E_FORCE=1 npm run e2e:electron` **26/26**。

### P0：修复 2026-07-19 手动验收阻断项

- [x] 隔离开发/E2E/真实用户的 Electron 最近项目恢复；普通启动不得自动恢复 `/private/tmp` 测试 fixture，并有真实 Electron 回归。
- [x] 为项目卡模型输出增加严格结构化生成、JSON 提取/字符串安全有界修复和最多一次受限重试；失败保留答案并提供“重新整理”。
- [x] 在缓存 ChangeSet 前验证完整 `edit.md` Front Matter，强制 `schema: writcraft.edit/v1`；旧 `v0` 只生成保留未知字段/正文的迁移 Diff。
- [x] 明确 Changes 预览与写盘边界，使用“确认并更新 edit.md”，成功后强制重读磁盘并聚焦；初始文件部分失败可续跑。
- [x] 展开 Front Matter 稳定错误码、真实行号、原因和“生成修复提案”；warning/结构歧义不会生成空 Diff。
- [x] 真实 Electron 覆盖无效 JSON、答案保留、预览零写入、确认落盘、部分创建续跑、重启保持、旧 schema 迁移与临时项目隔离。

### P0 历史基线与当前复跑

- [x] 该历史批次源码复跑：`npm test`、沙箱外 `npm run verify` 均 exit 0，force Electron E2E 连续两轮 26/26；Inline 与 Plan 独立复审均 P0=0/P1=0，Graph 性能批独立复审 P0=0/P1=0/P2=0。后续 Graph 韧性修改后的当前门禁见 0.0I，不得混用。
- [x] 复验 A→B 项目切换时 metrics、Research、image 的延迟结果都不污染 B。

### P1：Phase B 分块修改与 Plan 交接（已关闭）

- [x] 冻结 `writcraft.plan/v2` 和 identifier-only Plan→Changes 交接；Main 绑定路径/revision，限制缓存为 8 条/2 小时并阻止 source/target drift。
- [x] 每个待审阅提案分配独立 `pc_*` capability，避免同内容 ChangeSet 覆盖 provenance 或误丢弃新提案。
- [x] 实现稳定 hunk ID、逐块/整文件决策、默认 pending、部分提交 residual、拒绝审计与 revision 安全顺序撤销。
- [x] 真实 Electron 覆盖三块接受/拒绝/待定、residual 续审、两批撤销，以及 Plan 任务人工接受后落盘。

### P1：Graph 产品闭环与扩展验收（已关闭）

- [x] 冻结 `writcraft.graph/v2` 的 Node / Edge / Evidence / Issue 契约；完成稳定 block/content 锚点、增量缓存和五类核心诊断。
- [x] 增加作者纠错闭环：合并别名、确认/否定事实、编辑属性；决定持久化并作为下一次抽取约束。
- [x] 将“建议修复”升级为结构化 Issue→Changes：绑定 `issueId`、证据 revision、目标范围和来源关系，stale 时阻止生成/应用。
- [x] 补齐 `claim_conflict`、`unresolved_foreshadow`、`orphan_entity` 与人物/变量/关系的跨文件演化表达。
- [x] 完成扩展验收审计并冻结 `GRAPH-ACCEPTANCE-V1-CONTRACT.md`：当时确认真实 Electron 仅完整覆盖 Issue→Changes，并据此列出筛选、双证据、stale、作者纠错、键盘/AX、最小窗口和性能的动态证据缺口；下一项已全部关闭这些门禁。
- [x] 用真实 Electron 覆盖人物/变量/时间筛选、冲突双证据、stale Evidence、作者纠错与结构化修复交接；补可访问性、布局和大型图谱性能复审。该 Graph 性能批强制 Electron 连续两轮 26/26，独立复审 P0=0/P1=0/P2=0；0.0AB 后续当时总链为 35/35，当前见顶部当前里程碑。

Graph Extended Acceptance v1 已签字。首轮复审曾以 P1=3 回退 watcher、cold-to-interactive 与 AX/failure-live；2026-07-23 性能复验进一步关闭索引、布局、baseline DOM 与可见帧计时缺口，该批源码全量 test/verify、强制 Electron 连续两轮 26/26 通过。后续 0.0I 韧性批已完成代码、定向测试与独立复审，并在 0.0AB 当时的强制 Electron 35/35 中再次通过后续 Graph 用户旅程；当前见顶部当前里程碑。

### P2：补齐真实 API 与作者证据

真实作者与付费网络的允许证据、隐私边界、必跑旅程和签字顺序已经冻结在 `../docs/AUTHOR-ACCEPTANCE-V1-CONTRACT.md`；stub、fixture、源码字符串或单次成功调用均不能替代该合同。

- [x] 冻结 `AUTHOR-ACCEPTANCE-V1-CONTRACT.md`：定义 2000+ 字/5+ 章真实项目、付费网络双门禁、允许记录的脱敏证据和发布前签字顺序；0.0BY 已把旧五段门禁修订为包含结构规划/写作导航的六段旅程。
- [x] 加固并签字真实 API acceptance 离线合同：Onboarding service 成为唯一 JSON 解析权威，稳定错误码保持可分类，image 报告解码尺寸/比例；凭据优先级、显式 profile 排他且 fail-closed、未知 scope、双门禁、无 Key、阶段顺序、恶意异常脱敏与失败清理动态 **15/15**，0 网络。它不等于真实付费 API 已执行。
- [x] 完成真实作者项目只读预检与隔离副本技术候选：**历史** 0.0O 为 Author **42/42**、0.0S 为 **47/47**；0.0U 签字基线为 **48/48**，新增 0755 pre-open replacement 零副作用拒绝及 shared/setgid 父目录兼容回归。
- [x] **历史** 0.0O 第六轮独立技术复审为 **P0=0/P1=0/P2=3，可以代码签字**；0.0P 已移除 Python 运行时 P2。0.0S 合计 **62/62、0 网络**，第三轮独立复审当时为 **P0=0/P1=0/P2=3**；Plan timing 已由 0.0T 关闭，reserve 副作用与威胁模型已由 0.0U 收口。当前按顶部当前里程碑的外部门禁续作。
- [x] 将 `/usr/bin/python3 -I` 替换为随 App 打包的 universal 原生 author-copy helper；0.0S 将 build signature 纳入 recipe，并串联 attestation→App helper→ZIP helper/完整 App tree。0.0V 已把 project-hash helper 纳入同一双-helper链；0.0Y 当时的 ad-hoc App/ZIP 通过 package **8/8**、release **7/7**。当前发布证据见本文顶部当前里程碑，ad-hoc App/ZIP 仍禁止分发。
- [x] 将 Onboarding/Graph 外部变化等待从 generation 静默窗口升级为 Main-owned exact watcher barrier；0.0Q 最终 Watcher 23/23、跨层 11/11、聚焦 2/2、同源完整 Electron 连续两次 32/32。
- [x] 将 strict watcher hash 改为 no-follow fd，打开后复核 inode/size 并有界读取，关闭 `lstat→path read` 最终文件组件并发替换 P2；0.0R Watcher 28/28、跨层 11/11、同源完整 Electron 连续两次 32/32，最终组件范围已签收。
- [x] 0.0S 已关闭 reserve 成功后 stdout/status 丢失的未知空 stage 与 build 因果：receipt 失败不猜测清理，身份已知失败只作 exact recheck 清理；标准打包 attestation 已贯穿到完整 App tree。不得把这写成全路径 TOCTOU 已消除。
- [x] 0.0T 关闭首次 Plan write timeout：保留历史红灯，以挂起式重复 refresh 回归稳定复现，修复后 Renderer **25/25**、三次真实 Electron **32/32**，独立复审 **P0=0/P1=0/P2=0**。
- [x] 0.0V 祖先逐段 `openat` 已签收：worker 10/10、Watcher 30/30、cross-layer 11/11、Large 6/6、package 8/8、release 7/7、全量 test/verify、Persistent 3/3、Electron 32/32；独立复审 P0=0/P1=0/P2=2。其当时的 payload metadata 已由 0.0W 关闭，初始根外层祖先已由 0.0X 关闭；0.0U 同 UID 0700 reserve residual 则已明确接受，三者不得混写。
- [x] 0.0W 已关闭 payload metadata P2：JS/native 同为精确 16 MiB 完整请求上限，worker 12/12；全量、Persistent 3/3、Electron 32/32、package 8/8、release 7/7 通过。其当时唯一 watcher P2 已由 0.0X 关闭。
- [x] 0.0X 已从可信文件系统根 fd 逐段绑定项目根外层祖先，并在每批前后重走完整根链；其当时复审的两个 P2 已由 0.0Y 关闭。
- [x] 0.0Y 已关闭 async-close write-after-end 与构造错误路径泄露：worker 18/18、Watcher 31/31、cross-layer 11/11、Large 6/6、全量、Persistent 3/3、Electron 32/32、package 8/8、release 7/7 通过；独立复审 P0=0/P1=0/P2=0。
- [x] Author Evidence Metrics v1 已签字：service **13/13**、integration **6/6**、Renderer **18/18**、Onboarding dynamic **22/22**、Workspace **19/19**、image **8/8**、Research **13/13**、Plan **16/16**、Graph handoff **6/6**；该 Metrics 批完整 `npm test`、Electron-enabled `npm run verify` 均 exit 0，强制 Electron **26/26**，独立复审 **P0=0/P1=0/P2=0**。0.0AB 后续当时总链为 35/35，当前见顶部当前里程碑。
- [x] 使用可控、开发态双门禁且未知请求 fail-closed 的 stub 完成 Research GUI：选择来源 → Claim/Source/Boundary → 制造 stale → 阻止 Changes → 重跑 → 人工确认交接。
- [x] 使用同一 stub 完成 Image Review GUI：完整 PNG 解码与比例证明 → 预览零正文写入 → 必填评分 → 显式插入/保留/废纸篓；动态三态、失败重试与真实 Electron 插入/保留均通过。
- [x] 在真实 GUI 中完成 metrics 项目内记录、聚合刷新与私有文件落盘；A→B 的 origin/path 隔离由现有 renderer/Main 专项动态验证。
- [x] 用用户显式配置的 Key 完成真实 `/models` 与最小 `/messages` 握手；设置只显示脱敏状态、模型可用性和延迟。
- [x] 用合成内容完成真实 MiniMax 项目卡提案与 Research 证据卡验收；记录延迟、结构化结果、quote 修复和磁盘零修改，不记录秘密、正文或模型原文。
- [x] 使用 Coding Plan Key 完成一次合成 `image-01` 能力/解码门禁：1280×720 JPEG、19,333 ms、零正文插入；Key 前缀不再被本地静态拒绝。
- [ ] 在真实 GUI 由作者完成人工 image-01 质量评分、采纳/保留/废纸篓决定，并按安全字段记录费用或限流样本；自动合成调用不能代替此项。
- [x] 为 `.writcraft/image-trash/` 增加可见恢复/清空入口与明确保留策略；V0 不自动永久删除，恢复/清空只走 Main 精确能力与真实 Electron 用户旅程。
- [x] Image Trash 最新 21/21 竞态加固最终独立复审：P0=0/P1=0/P2=1，可以签字；P2 为非阻断 external open-FD residual。
- [x] 在真实 GUI 完成“项目卡 → edit.md ChangeSet → 人工确认 → 磁盘落盘 → 独立确认创建初始文件”；0.0AR 旧副本曾创建 10 个文件，0.0AX 当前 fresh 副本创建 9 个文件，并记录一次结构化失败后作者重试成功。两次证据按各自 copy manifest 切分，旧副本不计入最终签字。
- [x] 真实作者 Inline 拒绝：第五副本 operation `8f093bb9…` 记录 `generated → rejected`，没有新增 History，目标 mtime 和磁盘内容保持在前一笔已接受真相；界面明确显示“原文已恢复”。
- [x] 真实作者 Inline 接受：第五副本 operation `cd20e785…` 产生唯一 post-manifest application/applied History `change_6516ccbc…`，目标 before/after revision 与磁盘 SHA-256 精确一致。
- [x] 真实作者 Inline Safe Undo：第五副本最新正文 History 已变为 `undone`，正文 SHA-256 恢复到 beforeHash `1bdb3a5c…`，14 个 Markdown 的组合摘要精确回到基线 `7ead5eaa…`，原始验收源保持不变。
- [x] 项目卡、Inline、第七副本 Chapter、新空项目结构规划、第九副本 Navigation 与第十二副本统一任务已关闭；旧 Plan、旧 Research→Changes 默认旅程及未受影响模块不再复测。剩余作者门禁只看本节 `image-01` 评分/终态。

### P2：Main 网络与安全审计

- [x] 列出 Main 唯一允许的远端主机和代码路径；Renderer CSP/session 双重断网并拒绝权限。
- [x] 加固可信 sender、project instance/revision、请求/响应上限、timeout/owner abort、零 POST retry、拒绝 redirect 和稳定错误脱敏。
- [x] 区分 Main 内部 revision 回声与真实外部修改；修复引用双阶段导入自我失效和 FSWatcher 异步 error 崩溃风险。
- [x] 独立复审 Research 的“元数据声明≠事实背书”和 image 的“预览≠插入”；真实 Electron 覆盖人工确认与显式插入。
- [x] 增加恶意 Markdown/恢复 HTML 的真实 Chromium DOM sanitizer 专项；覆盖清洗、插入、二次解析、namespace、URL、DOM clobbering 与超量节点 fail-closed，当前 **13/13**。
- [x] 固定正式 userData、完成受限一次性迁移与 E2E profile 隔离；握手和真实验收脚本默认离线、显式门禁且输出脱敏。

真实验收命令（只有显式门禁才联网）：

```bash
WRITCRAFT_REAL_API_ACCEPTANCE=1 npm run acceptance:api
WRITCRAFT_REAL_API_ACCEPTANCE=1 WRITCRAFT_REAL_API_SCOPE=image WRITCRAFT_REAL_API_IMAGE=1 npm run acceptance:api
```

第二条可使用 `sk-cp-` 或 `sk-api-`；实际能力取决于 MiniMax 当前套餐、Credits 和每日额度，不能按 Key 前缀静态推断。

### P3：真实作者闭环

- [x] 在 Sources 为 Research 证据增加明确的“主张匹配 / 不匹配”作者判断并纳入私有聚合；Research Accuracy v1 已完成第四轮独立复审与全量签字，且作者判断不得冒充平台事实评分。
- [ ] 使用真实作者项目取得 Research 准确率样本；自动化判断与 fixture 不得替代作者证据。
- [ ] 图片质量评分与账单费用只在真实 `image-01` 人工旅程记录安全枚举/数值；自动化不得臆测质量或费用。
- [ ] 用真实 2000+ 字、5+ 章项目跑项目定义 → 写作 → Research → 插图 → 跨文件 → 图谱 → 重启恢复。
- [ ] 得到真实 inline 接受率、导航帮助度/动作、Research 准确率和图片采纳样本后，再决定是否进入 10 名作者内测。

### P4：打包与发布复审（最后做）

- [x] 建立 npm Developer Preview CLI、发布白名单、精确 Electron 运行时依赖和独立 tarball 安装验证；0.0AD 已将历史 `UNLICENSED` 候选替换为所有者确认的 `WritCraft Proprietary Evaluation License 1.0`。
- [x] 对 0.0AC 完成代码、发布合同与文档一致性三路独立终审，最终 P0/P1/P2=0；代码/测试/合同提交 `71571b8`，同一条 Nowledge 权威记忆已更新并反查。
- [x] 在 npm 10/arm64 与 npm 11/x64 完成 fresh-tarball `--check`、Main-observed page-load IPC、退出与清理矩阵，各 **2/2**。x64 首轮测试 PATH 缺 `/usr/sbin` 的环境红灯已保留；补回标准 PATH 后同源码通过。
- [x] 临发布时 `npm whoami` 已验证为 `houxyue`，`npm audit --omit=dev` 为 0 vulnerabilities，`writ-craft` 只读查询当时为 E404；当前已公开 `0.1.0`，本条仅保留发布前门禁证据。
- [x] 0.0AD P1 修复后的最终完整主链、三路独立复审、候选 Git 提交 `3390a86` 与 Nowledge 权威记忆同步已完成；临发布仍需重新核验名称与再次 audit。
- [x] 用户已显式授权并完成浏览器认证发布；`preview: 0.1.0`、公开 shasum、公网/本地隔离验收各 2/2、合同/测试、提交 `b48e294`、Nowledge 与两路独立终审 P0/P1/P2=0 已关闭。首包同时存在 registry 强制的 `latest: 0.1.0`，不执行 unpublish 或占位发布。
- [x] 0.1.1 补丁已从 exact candidate `c65981e` 发布到 npm `preview`；公网 shasum 匹配、隔离安装 2/2，annotated tag 与 GitHub prerelease 指向同一候选。`latest` 有意保留 0.1.0，未上传未签名 App/ZIP。
- [ ] 若未来转向独立 macOS App，再完成干净账户 Finder 启动、Developer ID、hardened runtime、时间戳、公证、staple 与 Gatekeeper。

## 5. 下次不要做

- 不要把 `npm run verify` 全绿写成真实 API、用户价值、安全或发布已验收。
- 不要把 Research A–D 展示成平台对真实性的评分，也不要在 use-time revision/quote 重验前跳转或交给 Changes。
- 不要让 metrics 记录正文、Prompt、模型回答、API Key、绝对路径或未知字段，也不要使用完成时的“当前项目”替代 origin。
- 不要让图片生成成功后静默插入正文，不要把短期远程 URL 当项目资产。
- 不要重打包旧源码、分发现有 ZIP 或复用历史测试数字。
- 不要把右侧 Diff/ChangeSet 预览描述成已经修改磁盘；只有明确应用成功并重读 revision 后才能显示“已更新 edit.md”。
- 不要让普通启动复用测试 fixture 的最近项目记录，也不要通过自动写入来掩盖项目卡提交入口不清晰的问题。

## 6. V0 完成定义

“V0 完成”必须同时满足：PRD §10、当前源码完整自动回归、真实 5+ 章 Electron 全链、真实 API 人工验收、Main 网络/安全与打包发布复审、独立复审无阻断项，以及真实内测指标支持 Continue。在此之前统一使用“候选原型”或“待人工/发布验收”；只有当次完整自动化实际通过时，才可写“自动化全绿，但仍待人工/发布验收”。
