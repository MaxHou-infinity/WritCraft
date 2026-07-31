# WritCraft 写作导航 v1 产品与工程合同

> 状态：`RM-1.1 / writ-craft@0.1.2` 当前冻结合同
> 生效日期：2026-07-31
> 取代：面向用户的 `writcraft.plan/v2` 里程碑、任务和依赖图
> 实现进度：0.0CD 已完成 Main/IPC/Renderer 公共纵切、旧 Plan 入口移除、结构确认与章节骨架三态事务、open/Research/Changes 动作、取消/恢复，并修复结构输入每字符重绘失焦与两阶段创建动作不可发现；真实 Electron 36/36，待空项目与真实作者隔离副本人工验收。

## 1. 产品判断

专业作者需要规划，但写作不是按软件项目任务图线性执行。笔触不再要求作者先生成“项目计划”，也不让 AI 根据一句指令批量写完整本书。新入口统一称为**导航**，只回答两个问题：

- 新项目：“这部作品可以怎样组织？”
- 已有稿件：“现在最值得推进什么？”

`edit.md` 始终是项目意图的权威来源。每个合法项目都必须有该文件，但其栏目可以为空或不完整；导航不得因为作者尚未填完项目卡而阻止使用。Main 每次读取已保存的权威 revision，UI 明确提示本次是否只获得了有限项目意图。模型输出只形成可解释建议；所有正文修改必须进入 Changes/Diff。

## 2. 两种用户模式

### 2.1 结构规划

V1 只适用于除 `edit.md` 外尚无公开 Markdown 正文的新项目。已有正文的项目不进入此模式，结构重审留给 Chat 或后续版本。AI 返回 2–3 个可比较方案，每个方案精确包含：

- 组织逻辑；
- 适合的读者体验与主要取舍；
- 1–8 个章节建议，每章只有标题与写作目的。

作者可以切换方案、修改标题和写作目的。Main 按最终顺序确定性生成 `chapters/01.md` 至 `chapters/08.md`；每个文件的精确 UTF-8 内容为：

```md
# <作者最终确认的标题>

<!-- 写作目的：<作者最终确认的写作目的> -->
```

文件末尾有一个换行，不含正文段落。该元数据骨架是“文件清单确认”的唯一写入例外，不进入 Changes；它只允许创建不存在的文件，绝不修改已有文件。确认页必须逐项展示路径、标题、目的和最终字节预览，并明确“只创建骨架，不会写章节正文”。一次性 Main capability 和全有或全无批量创建绑定 `edit.md` revision、空项目树、项目 instance 与 mutation generation；漂移、路径冲突、过期或部分失败均零个可见新文件。

模型值和作者编辑后的 `title` / `purpose` 必须重新通过同一 raw safe-text validator：拒绝 CR、LF、NUL、全部 C0 控制字符和孤立 UTF-16 surrogate；`purpose` 额外拒绝任何 `--`。Main 不 escape、截断、trim 或修补输入。创建 `chapters/`、stage 和全部文件属于同一三态事务：precommit failure 不得残留目录、stage 或文件；提交后的 fsync/响应异常必须从磁盘及 durable receipt 重建“已提交”或“提交状态未知”，绝不作为普通失败诱导重复确认。

### 2.2 写作导航

适用于至少有一个公开 Markdown 正文的项目。AI 返回 1–3 张“下一步建议”，每张精确包含：

- 发现了什么问题或机会；
- 一至三个证据锚点：现有相对路径、唯一章节标题和不超过 160 字的原文片段；
- 为什么现在值得处理；
- 建议采取什么动作；
- 完成后预期改善什么。

动作仅允许：

1. **打开章节**：本地导航，不调用 AI、不写盘；
2. **补充来源**：进入 Research，保留当前建议的证据锚点；
3. **生成修改建议**：进入 Changes，重新读取权威 revision 后生成可审阅 Diff。

建议不是待办列表，不显示任务 ID、依赖关系、里程碑、完成率或“交给 AI”。

Main 必须把模型锚点解析为 canonical block locator，并绑定当时 revision；路径不存在、标题不唯一、片段不在该区块或证据超出实际读取范围时整次结果失败。UI 在卡片旁显示“基于本次已读取的 X/Y 个正文文件”，列出 Context manifest、被省略数量和截断原因；未覆盖全项目时只能说“在本次已读范围内优先”，不得声称“全项目最重要”。

## 3. 有界模型合同

### 3.1 结构规划输出

- 顶层精确为 `{"mode":"structure","alternatives":[...]}`；
- 每个 alternative 精确为 `organizingLogic`、`audienceBenefit`、`tradeoff`、`chapters`；
- 每个 chapter 精确为 `title`、`purpose`；
- 方案 2–3 个；
- `organizingLogic` 1–120 字、`audienceBenefit` 1–100 字、`tradeoff` 1–100 字；
- 每方案 1–8 章；`title` 1–40 字、`purpose` 1–120 字；
- 无 ID、依赖、正文、路径或额外字段。

### 3.2 写作导航输出

- 顶层精确为 `{"mode":"navigation","suggestions":[...]}`；
- 每个 suggestion 精确为 `finding`、`evidence`、`whyNow`、`recommendedAction`、`expectedResult`、`action`；
- 每个 evidence 精确为 `relativePath`、`sectionHeading`、`quote`；
- 建议 1–3 张；
- `finding`、`whyNow`、`expectedResult` 各 1–160 字；
- `recommendedAction` 1–80 字，`action` 只能为 `open`、`research`、`changes`；
- 每张 1–3 个 evidence；`relativePath` 服从现有公开路径合同，`sectionHeading` 1–120 字，`quote` 1–160 字；
- 无模型自定 ID、revision、任务状态或额外字段；opaque ID 只由 Main 在验证后生成。

两种模式都必须使用一个专用 named tool；Main 只接受一个匹配的 bounded plain-JSON input。provider request（含 prompt、context、tool schema）不超过 1 MiB，tool input 序列化后不超过 64 KiB，`max_tokens` 为 8192，deadline 为 90 秒。上下文最多 8 个正文文件、聚合 240 KiB；当前正文计入这 8 个总额，Context manifest 的 X/Y 使用同一总数定义。Main 在实现测试中用全上限 Unicode fixture 证明 schema、字符计数和序列化字节闭合。

每次用户点击最多一次付费 provider 调用。格式、字段、证据或容量失败均直接给出内容无关、可执行的失败说明，不自动重试；只有作者再次明确点击才产生新调用。取消和 deadline 终止当次 owner，迟到响应无 authority。

## 4. Main 权威、缓存与交接

- Renderer 只提交模式、用户目标和显式选择的上下文标识；不得提交自称可信的文件内容。
- Main 读取已保存的 `edit.md` 和总计最多 8 个正文文件；当前正文若存在则占用一个名额，其余名额来自作者显式选择。Main 绑定 project instance、navigation/mutation generation、路径、block locator 与 revision。正文不足或 `edit.md` 栏目为空不会被模型伪装成已知信息。
- 模型的结构化传输格式属于内部协议，不向作者展示 JSON 或字段错误。
- Main 必须严格验证模式、数量、字符/字节上限、现有证据路径和允许动作；不猜测、不修补、不把字符串强制转换成数组。
- 模型不得获得写 capability。缓存最多保存 8 次结果、每次最多 3 张建议、TTL 30 分钟；按项目 instance 与 owner 隔离，超限淘汰最旧结果并使其 capability 失效。
- `open` 可在同一有效建议上重复使用，但每次都重验项目、路径、locator 与 revision；只导航，不消费写权限。
- `research` 和 `changes` 使用各自单次 opaque action capability。执行前重验全部证据、Context manifest、当前项目和 generation；成功交接或任何 stale/replay 都使该 action capability 终止。
- 每次执行另绑定一个 opaque attempt ID。普通失败、超时或作者取消只结束该 attempt，并保留仍 current 的 action 供显式重试；旧 attempt 的迟到取消或 finally 不得影响新 attempt。
- 已有待审 Changes 时，`changes` 返回 `REVIEW_IN_PROGRESS` 并保留当前审阅，绝不替换或丢弃；作者处理完后须从仍有效的建议重新发起，过期则重新生成导航。
- 项目 A 的迟到生成、handoff 或 finally 不得改变项目 B 的缓存、busy、Context manifest 或待审 Changes。
- 生成失败、取消、项目切换、revision 漂移和无有效建议均不得写入 Markdown、History、Changes 或 mutation generation。

内部跨文件预检仍可计算目标、revision 和执行顺序，但这些是安全实现细节，不是作者必须维护的公开计划。

## 5. 明确不做

- 不做一句话生成整本书、连续自动写作或无人值守 Autopilot；
- 不批量生成章节正文，不把确认骨架解释为接受内容；
- 不把“结构规划”重复成项目卡；已有 `edit.md` 内容直接作为输入，空栏目如实披露；
- 不用模型格式服从率衡量作者价值；
- 不为兼容旧 Plan 保留第二套可见工作流。

## 6. 验收

### 6.1 自动化

- 空项目返回 2–3 个结构方案；模型值和作者编辑值的 raw validator、精确骨架字节及三态提交恢复有动态证明；显式确认前零写入，precommit failure 零残留，committed/unknown 不谎报；已有正文时结构模式 fail-closed；
- 已有项目返回 1–3 张完整建议，三种动作路由正确；
- schema/input/request/context 的最大合法 fixture 与超一边界均有测试；一次点击至多一次 provider call；
- evidence path、标题、quote、locator、revision 不匹配，Context 不完整披露，项目切换，缓存过期，重复消费和 A→B 迟到均 fail-closed；
- 已有 pending Changes 时不替换审阅，Research/Changes 各自 capability 互不串用；
- 所有生成失败证明 Markdown、History、Changes 和 mutation generation 零变化；
- 任何正文修改都只能在 Changes 中接受后落盘；
- 真实跨组件测试覆盖进度、取消、恢复、旧 finally/新项目重叠和无陈旧 busy 状态。

### 6.2 真实作者

空项目必须由作者明确选择新的独立目录，初始只含应用创建的 `edit.md` 与 `.writcraft/project.json`；验收前记录内容无关的相对文件清单与摘要，完成“比较方案 → 编辑骨架 → 确认创建”后证明只新增作者确认的骨架，失败/拒绝时零新增。它不从真实原稿复制，也不扫描其他目录。

已有稿件使用作者授权的全新合格隔离副本，完成“查看 Context 覆盖 → 查看建议 → 打开章节”以及“建议 → Changes → 拒绝或接受 → Safe Undo”，并继续证明原始项目快照不变。验收只记录内容无关的模式、覆盖计数、动作、耗时、稳定错误码和作者是否认为建议有帮助，不保存提示词、建议文本、quote 或正文。

旧 Plan 的九次真实失败保留为历史证据，不再要求作者继续付费复测。完成定向测试、完整回归、真实 Electron 和独立复审 P0/P1=0 后，才能把本合同标为实现完成。
