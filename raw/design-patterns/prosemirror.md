# ProseMirror 架构分析

> 证据等级：A（官方文档 + 官方博客 + Marijn Haverbeke 开源实现）
> 时效：2026-07-14，基于 ProseMirror 1.0.x

---

## 1. 核心定位：工具箱而非编辑器

ProseMirror 不同于一般富文本编辑器库，它是**一套用于构建富文本编辑器的 Lego 工具集**（Marijn Haverbeke 原话）。官方定位是"做正确的事，而不是做容易的事"，因此核心库不提供开箱即用的编辑器——你需要自己组装各个模块。

这一设计哲学对 WritCraft 极为关键：**自定义内容模型（大纲/章节/脚注/引用）需要深入 ProseMirror schema 设计，而非简单配置**。

---

## 2. 四大核心模块

ProseMirror 由四个必需模块组成（加若干可选扩展）：

### 2.1 `prosemirror-model` — 文档模型（最核心）

**Node（节点）**：ProseMirror 的内容基本单位。文档是一棵树：
```
doc
├── heading (level: 1)
├── paragraph
│   ├── text "这是"
│   └── text "内容"
├── blockquote
│   └── paragraph
└── footnote*
```

**Marks（标记）**：附着在 Node 上的元数据，最常见的是文本格式（bold/italic/code），但设计上**不限于格式**——footnote、comment、AI-suggestion-diff 都可以用 Marks 表示：

```typescript
// AI 差异建议可以用 Mark 表示
const aiSuggestionMark = {
  type: 'ai-suggestion',
  attrs: {
    originalText: '原始内容',
    suggestedText: 'AI建议内容',
    modelId: 'claude-3.5',
    confidence: 0.92
  }
};
```

**Schema（模式）**：定义文档中允许的 Node 类型及其关系。Schema 是 ProseMirror 的灵魂：

```typescript
const mySchema = new Schema({
  nodes: {
    doc: { content: 'block+' },           // 文档包含多个 block
    paragraph: { content: 'inline*' },   // 段落包含多个 inline
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*'
    },
    blockquote: { content: 'block+' },
    footnote: { atom: true },              // atom = 不含可编辑子内容
    // 自定义节点
    'ai-suggestion': {                   // AI 建议块
      group: 'block',
      content: 'text*',
      attrs: {
        originalText: { default: '' },
        modelId: { default: '' },
        confidence: { default: 1.0 }
      }
    }
  },
  marks: {
    bold: {},
    italic: {},
    code: {},
    'ai-inline': {                      // 行内 AI 建议（Mark 而非 Node）
      attrs: {
        originalText: {},
        suggestedText: {},
        confidence: { default: 1.0 }
      }
    },
    link: {
      attrs: { href: {}, title: { default: null } }
    },
    footnote_ref: {
      attrs: { footnoteId: {} }
    }
  }
});
```

**Schema 对结构化写作的关键意义**：
- **大纲（Heading hierarchy）**：用 `heading` 节点 + `level` 属性自然建模
- **脚注（Footnotes）**：用 `footnote_ref` Mark 引用 + 独立 `footnote` 节点表
- **交叉引用**：用自定义 Mark 携带目标节点 ID
- **AI 建议差异**：用 `ai-inline` Mark 或独立 `ai-suggestion` Node 表示

### 2.2 `prosemirror-state` — 状态管理

EditorState 包含：
- `doc`：当前文档树
- `selection`：光标位置信息
- `storedMarks`：临时 marks（如输入时的格式状态）

**Transaction（事务）**：所有状态变更必须通过 Transaction，而不是直接修改 doc。每次变更生成一个 Transaction，可记录、重放、支持 undo/redo。这是协作编辑和 AI 差异应用的数学基础。

```typescript
// AI 接受建议：创建一个 Transaction 替换原文本
const tr = editorState.tr;
tr.replaceWith(
  from,                    // 起始位置
  to,                      // 结束位置
  schema.nodes.text.create({}, suggestedTextNode)
);
tr.setMeta('aiSuggestionAccepted', true);
editorView.dispatch(tr);
```

### 2.3 `prosemirror-view` — 渲染层

负责将 EditorState 渲染为可编辑的 DOM 元素，并捕获用户交互转换为 Transaction。

**关键设计**：View 不直接操作文档，而是生成 Transaction 交给 State 处理，State 更新后再驱动 View 重渲染。这是**单向数据流**，保证了状态一致性。

### 2.4 `prosemirror-transform` — 变更系统

包含所有文档修改操作（replace、setMark、addMark、removeMark 等），这些操作可以：
- **序列化**：存储为 JSON，可重放
- **逆向操作**：自动生成 inverse，用于 undo
- **OT 协同**：变更作为 OT 消息在协作者间传输

---

## 3. 协作编辑架构

ProseMirror 内置了 **OT（Operational Transformation）** 协作支持，通过 `prosemirror-collab` 模块：

```typescript
import collab from 'prosemirror-collab';

// 服务端（authority）维护文档版本和变更历史
// 客户端通过 collab plugin 同步变更
const collabPlugin = collab.collab({
  version: serverState.version
});

// 发送本地变更到服务器
view.dispatchTransaction((tr) => {
  const newState = view.state.apply(tr);
  const sendable = collab.sendableSteps(newState);
  if (sendable) {
    ws.send(JSON.stringify({
      version: sendable.version,
      steps: sendable.steps,
      clientID: sendable.clientID
    }));
  }
});

// 接收服务器推送的远程变更
ws.onmessage = (event) => {
  const { version, steps, clientID } = JSON.parse(event.data);
  const newState = collab.receiveTransaction(
    view.state, steps, clientID, version
  );
  view.updateState(newState);
};
```

**注意**：虽然 ProseMirror 内置了 OT 协作，但实际生产中更多人选择 **Yjs（CRDT）** 方案，原因：
- OT 在高延迟（P2P/离线）场景下行为复杂
- Yjs 实现更简单，冲突解决更优雅
- TipTap、Lexical 均选择 Yjs 而非 ProseMirror Collab

---

## 4. 对结构化写作（大纲/章节/脚注）的意义

### 4.1 Schema 设计是核心

ProseMirror 的 Schema 不是简单的"允许哪些 HTML 标签"，而是**完整的文档内容模型**。例如 WritCraft 的内容模型可以这样设计：

```typescript
// WritCraft 文档 Schema 片段
const writCraftSchema = new Schema({
  nodes: {
    doc: { content: 'title banner? outline block*' },
    
    title: {               // 文档标题
      content: 'text',
      attrs: { planId: { default: null } }
    },
    
    banner: {              // 计划横幅（Plan Mode 产物）
      content: 'text',
      attrs: {
        planMode: { default: 'writing' },
        goalSummary: {},
        constraints: {}
      }
    },
    
    outline: {             // 大纲（Plan Mode 产物）
      content: 'outline_item*',
      attrs: { version: { default: 1 } }
    },
    
    outline_item: {
      content: 'text',
      attrs: {
        depth: { default: 1 },
        status: { default: 'pending' },  // pending | drafted | reviewed
        refId: { default: null }          // 关联章节 ID
      }
    },
    
    heading: {             // 章节标题
      content: 'inline*',
      attrs: {
        level: { default: 1 },
        refId: { default: null }           // 用于交叉引用
      }
    },
    
    section: {             // 章节（可嵌套）
      content: 'block+',
      attrs: {
        refId: { default: null }
      }
    },
    
    paragraph: {
      content: 'inline*',
      defining: true       // 定义性段落，选择时包含整段
    },
    
    footnote: {            // 脚注
      atom: true,
      attrs: {
        id: {},
        number: { default: 1 }
      }
    },
    
    figure: {               // 多模态插图
      atom: true,
      attrs: {
        imageUrl: {},
        caption: { default: '' },
        altText: {}
      }
    },
    
    // AI 建议节点
    'ai-suggestion': {
      group: 'block',
      content: 'text*',
      attrs: {
        originalText: {},
        suggestedText: {},
        diffMode: { default: 'word' },   // word | sentence | paragraph
        modelId: {},
        confidence: { default: 1.0 }
      }
    }
  },
  
  marks: {
    bold: {},
    italic: {},
    underline: {},
    code: {},
    
    link: {
      attrs: { href: {}, refId: { default: null } }
    },
    
    'footnote-ref': {
      attrs: { footnoteId: {} }
    },
    
    // 行内 AI 建议（用于逐句 diff）
    'ai-inline-diff': {
      attrs: {
        originalText: {},
        suggestedText: {},
        status: { default: 'pending' }  // pending | accepted | rejected
      }
    },
    
    citation: {
      attrs: {
        sourceId: {},
        page: { default: null }
      }
    }
  }
});
```

### 4.2 变换（Transform）支持 Plan Mode

ProseMirror 的 Transaction 系统天然支持 **Plan Mode 的核心需求**：

1. **大纲锁定**：写入时锁定 outline 区域，用户只能在 draft 区域编辑
2. **Diff 追踪**：每次 AI 建议生成一个 `ai-inline-diff` Mark，接受时用 Transaction 替换
3. **版本化**：outline_item 的 `status` 属性跟踪写作进度

---

## 5. AI 集成的可能路径

ProseMirror 本身不提供 AI 能力，但可以通过以下方式集成：

### 5.1 Mark 注入 + Transaction 应用

```typescript
// 监听用户选区，生成 AI 建议
editorView.dom.addEventListener('mouseup', async () => {
  const { from, to } = editorView.state.selection;
  if (from === to) return; // 需有选区
  
  const selectedText = state.doc.textBetween(from, to);
  const aiSuggestion = await aiService.suggest(selectedText);
  
  // 用 Mark 表示建议（灰色预览，接受时替换）
  const tr = editorView.state.tr;
  tr.addMark(from, to, schema.marks['ai-inline-diff'].create({
    originalText: selectedText,
    suggestedText: aiSuggestion.text
  }));
  editorView.dispatch(tr);
});
```

### 5.2 装饰器（Decoration）方案

对于 Ghost Text 风格（不修改文档，悬浮显示建议），用 ProseMirror 的 **Decoration** 而非 Mark：

```typescript
import {Decoration, DecorationSet} from 'prosemirror-view';

const aiSuggestionPlugin = new Plugin({
  props: {
    decorations(state) {
      // 根据 AI 建议状态，添加装饰
      return DecorationSet.create(state.doc, [
        Decoration.inline(from, to, {
          class: 'ai-ghost-text',
          style: 'color: gray; font-style: italic;'
        })
      ]);
    }
  }
});
```

---

## 6. 关键架构对比总结

| 维度 | ProseMirror |
|------|-------------|
| 渲染方式 | View 层绑定原生 DOM（contenteditable），但变更走 Transaction |
| AI 接入方式 | Mark 注入 / Decoration 装饰 / Transaction 应用 |
| Ghost Text | ✅ 可实现（Decoration 方案），但需自建 UI |
| 内容模型 | ✅ **Schema 完全可自定义**，支持复杂文档结构 |
| 富文本编辑 | ✅ 原生支持，Schema 驱动 |
| 协作 | ✅ 内置 OT，可扩展 Yjs |
| Plan Mode 支持 | ✅ **最强**，Schema + Transaction 可精确控制编辑区域 |
| 多模态 | ✅ 可自定义 Node（figure, table），需自行实现渲染 |
| 学习曲线 | 高（无 UI，需自行组装） |
