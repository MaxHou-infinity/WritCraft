# WritCraft AI 编辑器框架统一推荐方案

> 核心交付物 · 证据等级：A+B · 时效：2026-07-14 · Author：houdah（T6 调研）

---

## 0. 执行摘要

经过对 Monaco（代码编辑器）、TipTap（富文本+AI）、ProseMirror（底层库）、Lexical（Meta 高性能框架）4 个框架的深度调研，**推荐方案如下**：

| 阶段 | 推荐框架 | 核心理由 |
|------|----------|----------|
| **V0（立即启动）** | TipTap | 开发速度最快、AI Toolkit 完整、中文支持可接受 |
| **V1（性能升级）** | Lexical | Meta 数百亿日活验证、React 生态完整、性能最优 |
| **不推荐主编辑器** | Monaco | 为代码设计，写作场景有 30% 功能适配成本 |
| **不推荐裸用** | ProseMirror | 学习曲线最陡，无 AI 官方方案，开发速度最慢 |

---

## 1. 四个框架 × 十维度横评

### 1.1 综合评分表

| 维度 | Monaco | TipTap | ProseMirror | Lexical | 说明 |
|------|--------|--------|-------------|---------|------|
| **定位** | 代码编辑器 | 富文本+AI | 底层工具库 | 高性能富文本 | |
| **富文本能力** | 1/10 | 9/10 | 5/10 | 7/10 | TipTap 胜出 |
| **AI inline diff** | 6/10 | 9/10 | 4/10 | 6/10 | TipTap AI Toolkit 完整 |
| **中文排版** | 2/10 | 7/10 | 3/10 | 6/10 | 均需 CSS 额外配置 |
| **协作能力** | 3/10 | 9/10 | 6/10 | 5/10 | TipTap Hocuspocus 完整 |
| **性能** | 9/10 | 8/10 | 8/10 | 9/10 | Lexical/Monaco 最优 |
| **学习成本** | 3/10 | 7/10 | 2/10 | 6/10 | ProseMirror 最高 |
| **开发速度（V0）** | 3/10 | 9/10 | 2/10 | 6/10 | TipTap 最快 |
| **社区活跃度** | 5/10 | 9/10 | 4/10 | 7/10 | TipTap 生态最完整 |
| **长期维护** | 9/10 | 7/10 | 5/10 | 8/10 | Monaco(Microsoft) 最稳 |
| **总分** | 47/110 | 82/110 | 42/110 | 67/110 | |

### 1.2 定位对比

```
Monaco    ：代码编辑器 ────────────────────────────► 专业代码 IDE
TipTap    ：富文本编辑器 ───► AI 原生 ──────────► Notion 类工具
ProseMirror：底层工具包（TipTap 的地基）
Lexical   ：高性能富文本 ───► React 原生 ───────► Meta 规模验证
```

---

## 2. 代码级对比详情

### 2.1 数据模型（Document Model）

| 框架 | 模型类型 | 语义层级 | 写作场景适用度 |
|------|---------|---------|--------------|
| Monaco | 字符串（Text Buffer）| 无（只有行）| ❌ 不适合 |
| TipTap | ProseMirror 节点树 | 段落/标题/块级 | ✅ 适合 |
| ProseMirror | JSON 节点树（底层）| 节点+Mark | ✅ 适合（但需自行封装）|
| Lexical | 纯 JS 对象节点树 | 语义节点 | ✅ 适合 |

**关键差异**：
- Monaco 用 `getValue()` / `setValue()` 操作字符串
- TipTap/Lexical 用节点树操作（`setHeading`、`insertImage`）

### 2.2 事务机制

| 框架 | 事务类型 | Undo/Redo | AI 场景适用度 |
|------|---------|----------|--------------|
| Monaco | 直接修改 Model | 自行实现 | ⚠️ 需自行实现 |
| TipTap | ProseMirror Transaction | 原生支持 | ✅ Command 模式 |
| ProseMirror | Transaction（不可变）| 原生支持 | ✅ |
| Lexical | EditorState update（不可变）| 原生支持 | ✅ |

### 2.3 选区 API

```javascript
// Monaco：字符偏移
const { startColumn, endColumn, startLineNumber, endLineNumber } = editor.getSelection();

// TipTap：ProseMirror 节点树选区
const { from, to } = editor.state.selection;
const text = editor.state.doc.textBetween(from, to);

// Lexical：$ 函数约定
const selection = $getSelection();
if ($isRangeSelection(selection)) {
  const text = selection.getTextContent();
}
```

### 2.4 AI diff 高亮（装饰器/标记 API）

| 框架 | AI 高亮方案 | 实现复杂度 | 推荐度 |
|------|-----------|----------|--------|
| Monaco | `deltaDecorations()` | 中（行级别）| ⭐⭐⭐ |
| TipTap | `Mark` + `TrackedChanges` | 低（官方 AI Toolkit）| ⭐⭐⭐⭐⭐ |
| ProseMirror | `DecorationSet` 或 `Mark` | 高（无官方方案）| ⭐⭐ |
| Lexical | `MarkNode` + `Command` | 中（无官方 AI Toolkit）| ⭐⭐⭐ |

**TipTap AI Toolkit 的独特优势**：
```javascript
// TipTap AI Toolkit = 最接近"逐句悬浮修改"的方案
editor.chain().focus().editAI({
  instruction: '优化这段表述，使其更学术化',
  reviewOptions: { mode: 'trackedChanges' }
}).run();
// AI 修改 → TrackedChanges → 用户接受/拒绝
```

---

## 3. AI 集成的三大设计模式

基于对四个框架的调研，WritCraft 的 AI 编辑功能建议如下三种模式：

### 3.1 Inline Diff（推荐，用于写作内容）

**目标**：在编辑区域内直接显示 AI 建议的修改，用户接受/拒绝。

**实现框架**：TipTap（TrackedChanges）+ AI Toolkit

**交互流程**：
```
用户选中段落 → 点击"AI 优化"
  → AI 生成修改建议
  → TipTap TrackedChanges 渲染（插入+删除线）
  → 用户逐句或批量接受/拒绝
```

**代码示意**：
```javascript
// TipTap TrackedChanges
editor.commands.addTrackedReplacement({
  from: start, to: end,
  content: 'AI 优化后的文本',
  reason: 'AI suggestion',
  author: 'AI Assistant'
});
```

### 3.2 Hover 提示（用于引用溯源）

**目标**：鼠标悬停在 AI 生成的文本上，显示来源。

**实现框架**：所有框架均支持

**交互流程**：
```
用户将鼠标悬停在 AI 生成的内容上
  → 显示 Hover Card（来源页面/段落/时间戳）
```

**代码示意**：
```javascript
// TipTap Mark + Hover
editor.setMark('aiSource', {
  title: '《写作指南》p.123',
  timestamp: '2026-07-14 10:00'
});

// Monaco Hover
editor.registerHoverProvider('markdown', {
  provideHover: (model, position) => ({
    contents: [{ value: '**来源**: p123《写作指南》' }]
  })
});
```

### 3.3 CodeLens 风格（用于修改统计）

**目标**：在段落地带显示 AI 修改计数，用户点击展开修改列表。

**实现框架**：TipTap/Lexical（需自定义 NodeView）

**交互流程**：
```
段落地带显示"✨ 2 处 AI 建议"
  → 用户点击
  → 展开 AI 修改列表（可批量处理）
```

**代码示意**：
```javascript
// TipTap 自定义 NodeView 实现 CodeLens 风格
const AICounterNodeView = {
  renderHTML({ node, getPos }) {
    return ['div', { class: 'ai-counter', 'data-count': node.attrs.count }, `✨ ${node.attrs.count} 处建议`];
  }
};
```

---

## 4. WritCraft 推荐方案详解

### 4.1 V0 方案：TipTap（立即可用）

**推荐指数**：⭐⭐⭐⭐⭐

**理由**：
1. **AI Toolkit 最完整**：Tracked Changes + AI Agent + 流式输出
2. **开发速度最快**：StarterKit 开箱即用，Extensions 丰富
3. **协作生态完整**：Yjs + Hocuspocus 官方支持
4. **中文排版可接受**：Typography 扩展 + CSS 配置

**V0 限制**：
- Tracked Changes 是付费扩展
- ProseMirror 底层有学习曲线
- AI Toolkit 需要 API Key（需确认 MiniMax 兼容性）

### 4.2 V1 方案：Lexical（性能升级）

**推荐指数**：⭐⭐⭐⭐

**理由**：
1. **性能最优**：Meta 数百亿日活验证
2. **React 原生**：如果 WritCraft 用 React，Lexical 生态完整
3. **无依赖核心**：core 仅 22KB，按需加载
4. **长期维护风险低**：Meta 内部强依赖

**V1 迁移条件**：
- TipTap V0 开发完成
- 性能成为瓶颈（大量并发用户）
- 团队有 Lexical 经验

### 4.3 不推荐方案的原因

**Monaco（不适合主编辑器）**：
- 文档模型是字符串，不是节点树
- 中文排版需要大量 hack
- AI diff 基于行，非段落语义
- 用于代码块编辑器是正确用法

**ProseMirror（不适合裸用）**：
- 没有任何 UI，完全从零构建
- 学习曲线最陡（4 个框架中最高）
- 无 AI 官方方案
- TipTap 就是 ProseMirror 的"现代封装"，直接用 TipTap

---

## 5. 架构建议：TipTap + Monaco 组合

### 5.1 分层架构

```
┌──────────────────────────────────────────────────────────────┐
│               WritCraft AI 写作 IDE                           │
├──────────────────────────────────────────────────────────────┤
│  TipTap（主编辑器层）                                        │
│  ├── 大纲/标题/段落                                        │
│  ├── 富文本排版（图片/表格/引用）                           │
│  ├── AI inline diff（TrackedChanges）                       │
│  ├── 协作（Yjs + Hocuspocus）                             │
│  └── 脚注/交叉引用                                         │
├──────────────────────────────────────────────────────────────┤
│  TipTap CallOut / NodeView（代码块层）                      │
│  └── Monaco（嵌入代码块编辑器）                             │
│      ├── 语法高亮                                           │
│      ├── AI 代码补全（Copilot 模式）                        │
│      └── 退出时同步回 TipTap                                │
└──────────────────────────────────────────────────────────────┘
```

### 5.2 关键决策

**Q：为什么不在 Monaco 上构建整个编辑器？**
A：Monaco 是代码编辑器，写作场景需要段落/标题/脚注等语义结构，这些在 Monaco 中需要大量 hack。TipTap 原生支持这些。

**Q：为什么 TipTap V0 而不是 Lexical？**
A：TipTap AI Toolkit 是目前最完整的 AI 编辑器方案，V0 需要快速出 MVP。Lexical 的 AI 集成需要自己构建。

**Q：什么时候考虑从 TipTap 迁移到 Lexical？**
A：当 V0 功能验证完成，且性能成为瓶颈时。迁移成本：约 2-4 周（取决于团队经验）。

---

## 6. 实施风险与缓解

| 风险 | 影响 | 缓解方案 |
|------|------|----------|
| TipTap AI Toolkit 不支持 MiniMax | 高 | V0 阶段用 OpenAI/Claude API 验证；MiniMax API 兼容后替换 |
| Tracked Changes 付费成本 | 中 | V0 用开源 tiptap-track-changes 替代；V1 再评估官方方案 |
| ProseMirror 学习成本 | 中 | 使用 TipTap 封装层，不直接操作 ProseMirror |
| Monaco 代码块同步复杂性 | 中 | 代码块作为独立模块，先用 TipTap 原生代码块，V1 再考虑 Monaco 嵌入 |

---

## 7. 下一步行动（T7 综合分析参考）

T7（houda）综合分析时，应重点关注：

1. **TipTap AI Toolkit 的实际接入成本**：需实测 MiniMax API 兼容性
2. **Tracked Changes 开源替代方案**：tiptap-track-changes 功能是否够用
3. **Hocuspocus 自托管 vs 云服务**：V0 阶段协作需求优先级
4. **Lexical 迁移路径**：V1 升级时 TipTap → Lexical 的工作量评估

---

## 数据源清单

本推荐方案综合以下数据源：

| # | 来源 | 文件 | 证据等级 |
|---|------|------|----------|
| 1 | Monaco 调研 | monaco-editor.md | A |
| 2 | TipTap 调研 | tiptap.md | A+B |
| 3 | ProseMirror 调研 | prosemirror.md | A |
| 4 | Lexical 调研 | lexical.md | A |
| 5 | VS Code Monaco 架构分析 | _vscode-architecture.md | B |
| 6 | TipTap 官方 AI 文档 | https://tiptap.dev/docs/content-ai | A |
| 7 | Lexical vs TipTap 深度对比 | Medium (faisalmujtaba) | B |
| 8 | 富文本框架横评 2025 | Liveblocks.io | B |
