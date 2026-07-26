# 写作 IDE 交互模式横向对比

> 面向 Max 写作软件项目的架构参考
> 数据来源：cursor-analysis.md、trae-analysis.md、windsurf-analysis.md

---

## 1. 核心交互模式分类

### 模式A：悬浮 Diff 逐句接受（Step-by-Step Diff Acceptance）

**代表产品：Cursor Composer**

这是 Cursor 最具辨识度的交互创新：

```
用户提出高层目标
    ↓
Composer 自动拆解任务 → 分配 subagent
    ↓
每个文件变更 → floating diff 窗口浮现
    ↓
用户逐句：Accept / Reject
    ↓
下一条变更浮现
```

**核心特点：**
- AI 产生的代码以"变更单元"为单位逐一呈现，而非整文件替换
- diff 窗口可折叠、展开、细粒度审查
- 用户始终掌控节奏，AI 等待用户确认
- 多文件变更时，每个文件都有独立 diff 窗口
- 支持 Composer 2.5 的 `@` 文件引用和 `/` 命令调用

**为什么这是好的交互设计：**
- 避免"一键替换整个文件"带来的风险（用户不知道 AI 改了哪里）
- 用户的认知负担最低：每次只处理一个变更单元
- 错误成本低：拒绝一个坏变更比回滚整个文件容易得多
- 符合 code review 的自然心智模型

---

### 模式B：实时流式 Approve/Reject（Real-Time Flow）

**代表产品：Windsurf Cascade**

Windsurf 的 Cascade 采取不同的哲学：

```
用户描述任务
    ↓
Cascade 在编辑器内实时做出变更（不用离开编辑器）
    ↓
用户观看变更实时应用（watch Cascade make changes in real time）
    ↓
每个变更可独立 approve 或 reject
    ↓
保持 flow state（心流状态）
```

**核心特点：**
- 变更直接在编辑器内呈现，无需弹出独立 diff 窗口
- 用户不需要在 chat panel 和 editor panel 之间切换
- Cascade 维持对项目的持久上下文理解
- 设计理念：AI 不是在另一个工具里工作，而是在"你工作的地方"工作

**与模式A的核心区别：**
| 维度 | Cursor（模式A）| Windsurf（模式B）|
|------|--------------|-----------------|
| 变更呈现位置 | 独立 floating diff 窗口 | 编辑器内直接呈现 |
| 用户操作区 | diff 窗口优先 | 编辑器优先 |
| 上下文积累 | 有限，需要新窗口 | 持久，session 内越来越懂你 |
| 适合场景 | 复杂多文件变更，需要仔细 review | 快速迭代，保持 flow |

---

### 模式C：纯会话式 Agent（Conversational Agent）

**代表产品：Trae SOLO / Cursor Agent 基础模式**

```
用户：实现登录功能
    ↓
Agent 回复：需要数据库模型和 API 路由，我先写...
    ↓
Agent 写文件，给出总结
    ↓
用户继续对话，给反馈
    ↓
Agent 迭代
```

**核心特点：**
- 变更以消息形式呈现（"我创建了 X 文件，修改了 Y"）
- 用户需要主动检查文件确认变更
- 不提供细粒度的 accept/reject
- 类似于"AI 助手在幕后工作，完成后汇报"

---

## 2. 多 Agent 并行交互模式

### Cursor Multi-Agent（最成熟的实现）

**交互架构：**
```
用户添加任务（⌘K）
    ↓
Agent Panel：最多 8 个并行 Agent
    ↓
每个 Agent 有独立：
  - 工作文件范围（per-task scope）
  - 选用模型（Opus-4.8 / Composer 2.5 / GPT-5.6 Sol / Gemini 3.1 Pro）
  - 审批策略
    ↓
Mission Control 网格视图统一管理
    ↓
Multi-Agent Judging：同一任务多模型同时尝试，选取最佳
```

**关键设计决策：**
- Agent 之间通过 git worktree 或远程机器隔离，不互相干扰
- 共享项目 context 但工作集隔离
- 适合大型重构：不同模块同时由不同 Agent 处理

### Trae SOLO 多并发（云端执行）

**交互架构：**
```
用户启动 SOLO 任务
    ↓
最多 10-20 个并发云任务（Pro/Ultra 档位）
    ↓
每个任务独立执行
    ↓
用户逐个 review 结果
```

**关键区别：** 云端执行，本地可以做其他事

---

## 3. Context 机制对比

| 机制 | Cursor | Windsurf | Trae |
|------|--------|----------|------|
| 索引方式 | 自定义 embedding model，全代码库语义搜索 | Fast Context（自研，13x faster）| 未明确披露 |
| 持久上下文 | ❌ 需开新窗口 | ✅ Cascade Flows 持久 | ❌ 需开新窗口 |
| 上下文积累上限 | 5-10 轮后需重开 | Session 越长越懂你 | 需验证 |
| 规则文件 | .cursor/rules/（MDC格式）| .windsurfrules | .rules |
| MCP 支持 | ✅ | ✅ | ✅ |
| 索引共享 | ✅（安全共享队友索引）| ❌ | ❌ |

---

## 4. 写作 IDE 可借鉴的关键设计点

### 4.1 逐句接受 > 整片替换

**参考：Cursor 的 floating diff**

写作 IDE 的 AI 辅助（润色、改写）可以采用类似设计：
- AI 产生的改写不是替换整段，而是逐句呈现差异
- 用户逐句 accept/reject
- 避免 AI 一键覆盖用户内容导致的不可逆问题

### 4.2 实时可视化 > 后置报告

**参考：Windsurf Cascade 的 real-time editing**

写作 IDE 可以：
- AI 在编辑区域实时呈现改写效果（类似"现场演出"）
- 用户实时看到文字变化，不需要切到预览面板
- 保持心流状态

### 4.3 持久上下文 > 每任务清零

**参考：Windsurf Cascade Flows 的 session memory**

写作 IDE 需要：
- 理解用户的写作风格、用词偏好、常用表达
- 在整个写作 session 中积累上下文
- 不同文档可以有独立的上下文记忆

### 4.4 多 Agent 协作 > 单一 Agent

**参考：Cursor 的 Multi-Agent Judging**

写作 IDE 可以：
- 同一改写任务，让多个 Agent 各自尝试，呈现不同方案
- 用户选择最佳版本
- 不同 Agent 可以专注于不同维度（逻辑、结构、语言风格）

### 4.5 细粒度规则配置

**参考：.cursor/rules/ 和 .windsurfrules**

写作 IDE 可以：
- 项目级/.docs/ 规则配置
- 团队写作规范同步
- 支持 .writingrules 或类似配置文件

---

## 5. 交互模式总结矩阵

| 特性 | Cursor | Windsurf | Trae |
|------|--------|----------|------|
| 悬浮 diff 逐句接受 | ✅ Composer | ❌ | ❌ |
| 实时流式编辑 | ❌ | ✅ Cascade | ❌ |
| 持久 session 上下文 | ❌（需新窗口）| ✅ | ❌ |
| 多 Agent 并行 | ✅（8个）| ❌ | ✅（10-20 云端）|
| Multi-Agent Judging | ✅ | ❌ | ❌ |
| Mission Control 视图 | ✅ | ❌ | ❌ |
| MCP 扩展 | ✅ | ✅ | ✅ |
| 视觉代码地图 | ❌ | ✅ Codemaps | ❌ |
| 自研专属模型 | ✅ Composer | ✅ SWE-1.5 | ❌ |
| 免费无限模型 | ❌ | ❌ | ✅ GPT-4o+Claude 3.5 |
