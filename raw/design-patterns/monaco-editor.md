# Monaco Editor 架构分析

> 证据等级：A（官方文档 + 开源代码）
> 时效：2026-07-14，基于 monaco-editor@0.52、VS Code 1.99

---

## 1. 定位：Monaco ≠ VS Code

Monaco Editor 是微软维护的**Web 代码编辑器引擎**（TypeScript开发），VS Code 是构建在 Monaco 之上的完整桌面 IDE 产品。二者关系：

```
VS Code = Monaco Editor + Extension Host + 开发工作台 + 终端 + 调试 + ...
Monaco Editor = 独立的代码编辑组件，可独立嵌入任意 Web 应用
```

**对 WritCraft 的含义**：参考 VS Code 的 AI 集成方式时，需区分哪些是 Monaco 自身能力，哪些是 VS Code 扩展系统提供的。

---

## 2. 核心架构：四层分离

### 2.1 语言服务层（Language Server Protocol）

Monaco 内置了对 **LSP（Language Server Protocol）** 的完整支持。LSP 是一种标准化协议，定义了语言服务器（独立进程）与编辑器之间的通信格式：

- `textDocument/completion` — 补全
- `textDocument/hover` — 悬停信息
- `textDocument/gotoDefinition` — 跳转定义
- `workspace/symbol` — 工作区符号搜索

Monaco 内置了多语言的默认语言服务（JavaScript/TypeScript/CSS/HTML/JSON），同时支持通过 LSP 接入外部语言服务器。这意味着 **AI 补全可以被视为一种特殊的 LSP 扩展**。

### 2.2 代码补全系统：Ghost Text 的实现基础

Monaco 提供了 `CompletionItem` API，支持设置 `insertText` 和 `range`，以及标记一个补全项为 **"幽灵文字"（Ghost Text / Inline Suggest）**：

```typescript
// Ghost Text 在 Monaco 中的表示方式
const ghostCompletion: monaco.languages.CompletionItem = {
  label: 'AI Suggestion',
  kind: monaco.languages.CompletionItemKind.Snippet,
  insertText: '这是 AI 建议的文本',
  range: {
    startLineNumber: 1,
    startColumn: 10,
    endLineNumber: 1,
    endColumn: 10
  },
  // 特殊标记：不立即插入，渲染为灰色预览
  additionalTextEdits: []
};
```

**Ghost Text 的关键设计**：VS Code/Copilot 使用 Monaco 的 `InlineCompletions` API，AI 生成的内容不是直接插入文档，而是以**灰色的差异覆盖（Inline Diff）**形式渲染在光标位置，用户按 Tab 接受或 Esc 拒绝。

Monaco 支持的 Inline Completions API 结构：
```typescript
monaco.languages.registerInlineCompletionsProvider(languageId, {
  provideInlineCompletions: async (model, position, context) => {
    // 调用 AI API 获取补全
    const suggestion = await aiService.getSuggestion(model, position);
    return {
      items: [{
        insertText: suggestion.text,
        range: { startLineNumber: position.lineNumber, ... },
        // ghost text 渲染模式
      }]
    };
  },
  freeInlineCompletions: (completions) => { ... }
});
```

### 2.3 多进程隔离：Extension Host 架构

VS Code（而非 Monaco）通过 **Extension Host**（独立 Node.js 进程）运行所有扩展，与主 UI 进程隔离，防止扩展崩溃影响编辑器核心。这个机制对 Copilot 聊天面板至关重要：

```
[主进程 / UI 线程]
    ↓ IPC
[Extension Host 进程] ← 运行 Copilot 扩展
    ↓
[语言服务器协议 (stdio/WebSocket)]
    ↓
[Copilot 后端服务]
```

对于 Web 嵌入场景，Monaco 本身不具备 Extension Host，但可通过 **Web Worker** 实现类似隔离：将 AI 推理请求发往 Worker 线程，避免阻塞主线程渲染。

### 2.4 渲染引擎：自绘制（Self-Rendered）

Monaco 不依赖浏览器原生 `contenteditable`，而是**完全自绘制**：每个字符、装饰、滚动条均由 Canvas 或 DOM 自己管理。这意味着：

- **AI 插入内容（Ghost Text）可以精确控制渲染**，不受 contenteditable 行为干扰
- 光标、选中区域、虚拟文本全部自定义实现
- 但也意味着**与富文本编辑（Rich Text）能力差距大**——Monaco 设计目标是代码编辑，不是结构化文档

---

## 3. AI 集成方式

### 3.1 Ghost Text / Inline Completions

最接近"逐句悬浮修改"的模式。通过 Monaco 的 `InlineCompletionsProvider` 接口：

```typescript
// 注册 AI 补全提供者
monaco.languages.registerInlineCompletionsProvider('markdown', {
  async provideInlineCompletions(model, position, context, token) {
    const precedingText = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column
    });
    
    const aiResult = await fetchAICompletion(precedingText);
    return {
      items: [{
        insertText: aiResult.text,
        range: {
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        },
        // Ghost Text 渲染：灰色、等宽、覆盖显示
      }]
    };
  }
});
```

### 3.2 Copilot Chat 集成（在 VS Code 中）

VS Code 中 Copilot 的侧边聊天面板是通过 **VS Code 扩展 API** 实现的，并非 Monaco 的能力。Chat 面板与编辑器之间的联动依赖 VS Code 的 `chat` API 和 `inline chat` API：

- `InlineChat`：在编辑器内部直接调起 AI 对话，光标位置生成差异修改
- `Chat View`：侧边栏多轮对话，支持引用文件、代码块

对 Web 应用的启发：Monaco 本身不提供 Chat UI，需自建，但 `InlineCompletions` 接口足够实现"逐句悬浮修改"。

### 3.3 Model Context Protocol (MCP)

VS Code 已在 2026 年支持 **MCP（Model Context Protocol）** 开放标准，允许 AI 通过标准接口调用外部工具和资源。Monaco 编辑器本身不实现 MCP，但通过 VS Code 扩展 API 可以接入。

---

## 4. 协作支持

Monaco 内置了 **WebSocket-based 协同编辑协议**（通过 `IModelDiffComputations` 和 `MonacoDiffEditor`），但主要是用于 diff 查看，而非多人实时编辑。

**协作编辑需要额外实现**，典型方案：
- **Yjs**：CRDT 库，与 Monaco 结合需要 `y-monaco` 绑定
- **OT（Operational Transformation）**：Monaco 不内置，需自行实现

---

## 5. 对 WritCraft 的适用性评估

### 优势
- ✅ **Ghost Text 实现成熟**：逐句悬浮 diff 渲染有明确 API 支持
- ✅ **性能优秀**：自绘制架构，不受 contenteditable 限制
- ✅ **多语言支持**：Markdown 代码高亮、代码块语法识别

### 劣势
- ❌ **富文本能力弱**：Monaco 设计目标是代码，不支持结构化写作（大纲/章节/脚注）
- ❌ **不原生支持 inline image**：图片需自定义实现
- ❌ **Plan Mode 需大量自建**：Monaco 不理解文档结构，无大纲/计划概念
- ❌ **Schema 不可扩展**：没有 ProseMirror/Lexical 那样的内容模型系统

### 适合场景
仅适合 **代码块内 AI 补全**（如内置示例代码、AI 生成代码片段），不适合作为 WritCraft 的核心编辑器。

---

## 6. 关键架构对比总结

| 维度 | Monaco Editor |
|------|-------------|
| 渲染方式 | 完全自绘制（Canvas/DOM），无 contenteditable |
| AI 接入方式 | `InlineCompletionsProvider` + LSP 扩展 |
| Ghost Text | ✅ 原生支持，灰色差异渲染 |
| 内容模型 | 无（纯字符串模型） |
| Schema/结构化 | ❌ 不支持 |
| 富文本编辑 | ❌ 仅代码风格 |
| 协作 | ❌ 需自行实现（Yjs 可集成） |
| 扩展机制 | Web Worker 隔离，非 Extension Host |
| 多模态（图片/图表） | ❌ 需完全自定义 |
