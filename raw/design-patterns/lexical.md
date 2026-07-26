# Lexical 架构分析

> 证据等级：A（官方文档 + GitHub）+ B（Meta 内部采用背景）
> 时效：2026-07-14，基于 Lexical 0.23.x

---

## 1. Meta 选择 Lexical 的核心原因

Meta 在 2022 年用 Lexical 替换了其所有内部编辑器的旧实现（包括 Facebook 主 App 的帖子编辑器、Instagram 的评论系统等），原因有三：

1. **性能**：Lexical 核心引擎零依赖（no dependencies），比 Draft.js 轻 10 倍
2. **可访问性（Accessibility）**：原生支持 ARIA，编辑器状态完全可序列化
3. **AI 友好性**：**contentEditable 分离设计** + **Yjs 一等公民支持**

---

## 2. 核心架构：Editor + EditorState + Commands

### 2.1 三层核心概念

Lexical 的核心比 ProseMirror 更简洁，只有三个主要概念：

```
Editor（编辑器实例）
    ↓ 创建
EditorState（当前状态快照，包含 doc + selection）
    ↓ 应用变更
Command（命令，分发后产生 Transaction → 新 EditorState）
```

**关键**：`EditorState` 是不可变的（Immutable），每次变更生成新快照，这使得：
- **Undo/Redo 极其简单**：只需维护 EditorState 历史栈
- **AI 状态注入友好**：AI 建议可以生成新 EditorState 而不影响原文档
- **调试友好**：任意时刻的 EditorState 可序列化和重放

### 2.2 节点类型

Lexical 的节点系统比 ProseMirror 更扁平：

```
RootNode
    └── ParagraphNode（叶节点，可编辑）
            └── TextNode（文本，带格式 Marks）
```

自定义节点继承链：
```
Node → ElementNode → DecendantNode → $createParagraphNode()
```

---

## 3. 关键创新：contentEditable 分离设计

这是 Lexical 区别于所有其他编辑器的最关键架构决策。

### 3.1 设计原则

Lexical **严格分离**：
- **逻辑层（EditorState）**：定义文档内容，与 DOM 无关
- **视图层（DOM/React）**：通过 reconciler 将 EditorState 映射到 DOM

```
[ EditorState (Immutable) ] ← → [ Reconciler ] ← → [ DOM (contentEditable) ]
         ↑                           ↓
    纯 JavaScript              计算差异
    可序列化                   最小化 DOM 操作
```

### 3.2 对 AI 状态注入的意义

由于 `contentEditable` **只是渲染层**，AI 可以直接操作 EditorState 而不受 DOM 状态干扰：

```typescript
// AI 修改建议 → 直接写入 EditorState → Reconciler 自动渲染差异
// 用户始终在操作 EditorState，不直接操作 DOM

editor.update(() => {
  // 在 EditorState 层面进行变更
  const root = $getRoot();
  const paragraph = root.getFirstChild();
  
  // AI 插入一个 ghost suggestion 作为特殊节点
  const suggestionNode = $createSuggestionNode({
    originalText: 'original',
    suggestedText: 'AI suggested text',
    status: 'pending'
  });
  
  // 在 paragraph 中插入 suggestion
  paragraph.append(suggestionNode);
});

// contentEditable 层自动渲染为：
// [原有文本][灰色 suggestion 块][原有文本继续]
```

### 3.3 Read-Only 模式（Plan Mode 基础）

Lexical 的 readOnly 模式**不冻结 reconciler**，只禁用 contentEditable：

```typescript
// Plan Mode 典型用法
editor.setReadOnly(true);  // 用户不可编辑

// 但 AI 仍可通过 editor.update() 注入内容
// Plan 区域通过 CSS 配合 editor.isEditable() 控制权限
```

这意味着 **Plan Mode 可以做到**：用户只能编辑 draft 区域，plan 区域只读但 AI 可以更新显示内容。

---

## 4. Yjs 协作：一等公民支持

### 4.1 Lexical + Yjs 集成架构

Lexical 官方维护 `@lexical/yjs`，将 Yjs 作为**默认协作层**，而非 ProseMirror 内置 OT：

```typescript
import { createWebsocketProvider } from 'y-websocket';
import LexicalCollaborationPlugin from '@lexical/react/LexicalCollaborationPlugin';
import { WebsocketProvider } from 'y-websocket';

// Yjs 文档
const ydoc = new Y.Doc();

// WebSocket 协作提供者
const provider = new WebsocketProvider(
  'wss://your-server.com',  // Yjs 同步服务器
  'writcraft-doc-1',         // 房间名
  ydoc
);

// Lexical 编辑器配置
const initialConfig = {
  namespace: 'WritCraftEditor',
  nodes: [
    // 注册支持协作同步的节点
    HeadingNode,
    ParagraphNode,
    SuggestionNode  // 自定义：AI 建议节点，需在构造函数中注册所有属性
  ],
  onError: console.error,
  editorState: null,  // 关键：让协作插件初始化 editor state
};

// 协作插件
<LexicalComposer initialConfig={initialConfig}>
  <RichTextPlugin />
  <CollaborationPlugin
    id="writcraft-doc-1"
    providerFactory={(id, yjsDocMap) => {
      return new WebsocketProvider('wss://...', id, ydoc);
    }}
    shouldBootstrap={true}
  />
</LexicalComposer>
```

### 4.2 自定义节点属性同步

**关键陷阱**：Yjs 通过检查节点的**自有可枚举属性**来同步自定义属性。必须在构造函数中显式初始化所有属性：

```typescript
// ✅ 正确：所有属性在构造函数中显式初始化
class SuggestionNode extends ElementNode {
  __originalText: string;
  __suggestedText: string;
  __status: 'pending' | 'accepted' | 'rejected';
  __modelId: string;
  
  constructor(originalText: string, suggestedText: string, modelId: string, 
              prevKey?: NodeKey) {
    super(prevKey);
    this.__originalText = originalText;
    this.__suggestedText = suggestedText;
    this.__status = 'pending';
    this.__modelId = modelId;
  }
}

// ❌ 错误：TypeScript 可选属性语法不创建实际属性
class WrongNode extends ElementNode {
  __suggestedText?: string;  // Yjs 同步不到！
  
  constructor() {
    super();
    // __suggestedText 永远不会同步
  }
}
```

---

## 5. AI 集成方式

### 5.1 Lexical + Yjs + AI Agent 典型架构

Meta 推荐的 AI + 协作编辑架构：

```
[ Lexical Editor ] ← → [ EditorState（Immutable）]
                            ↓
                    [ Yjs Doc（共享状态）]
                            ↓
[ AI Agent ] ← 可以是任意 LLM，通过 Yjs 感知文档状态
```

AI 通过 Yjs 的 `observe` 监听文档变更，通过 Yjs 的 `transact` 注入修改：

```typescript
ydoc.getText('editor').observe((event) => {
  // 监听用户编辑
  const currentText = ydoc.getText('editor').toString();
  
  // 触发 AI 建议
  if (shouldSuggest(currentText)) {
    aiService.suggest(currentText).then(suggestion => {
      // 通过 Yjs 注入 AI 建议（所有客户端同步可见）
      ydoc.transact(() => {
        const suggestionNode = $createSuggestionNode(suggestion);
        // 插入到文档中...
      });
    });
  }
});
```

### 5.2 AI 状态注入的两种模式

#### 模式 A：Ghost Text（悬浮建议）

```typescript
// Lexical 的 Decorator 机制适合实现 Ghost Text
// DecoratorNode 是不受文档流影响的特殊节点

class GhostTextNode extends DecoratorNode {
  __text: string;
  __status: 'streaming' | 'done' | 'accepted' | 'rejected';
  
  decorate(editor, config) {
    return `<span class="ghost-text ${this.__status}">${this.__text}</span>`;
  }
}
```

#### 模式 B：Inline Diff（逐句修改）

```typescript
// 逐句 diff 用 TextNode + 特殊格式 Mark 实现
editor.update(() => {
  const nodes = $getNodes();
  nodes.forEach(node => {
    if (node instanceof TextNode) {
      // 检查是否有 AI 建议覆盖
      const aiMark = node.getMarks().find(m => m.type === 'ai-suggestion');
      if (aiMark) {
        // 渲染为双层文字（删除线 + 插入）
        node.addFormat('underline'); // 原有文字
        // 在同一位置克隆一个 pending text node
      }
    }
  });
});
```

---

## 6. 对 WritCraft Plan Mode 的支持

### 6.1 编辑区域锁定

Lexical 的 `setEditable(false)` + 节点级权限检查：

```typescript
// Plan Mode：大纲区域只读
editor.setEditable(false);  // 全局禁用

// 但通过 editor.update() 强制注入 AI 内容
// 渲染层通过 CSS 实现视觉区分：
// .plan-section { pointer-events: none; background: #f9f9f9; }
// .draft-section { pointer-events: auto; background: #ffffff; }

// 编辑区域判断
const canEdit = (node) => {
  const plan = node.getFirstAncestor('plan-section');
  return plan ? false : true;
};
```

### 6.2 逐句 Diff 追踪

Lexical 的 `History` 机制天然支持追踪变更：

```typescript
import { registerKeyboardShortcuts } from '@lexical/utils';

// 每次 AI 建议生成 → 记录 EditorState 快照
// 用户接受 → 合并到主文档 → 记录新快照
// 用户拒绝 → 恢复到接受前状态
```

---

## 7. 关键架构对比总结

| 维度 | Lexical |
|------|---------|
| 渲染方式 | 独立 Reconciler → contentEditable（DOM 完全由 Lexical 控制） |
| AI 接入方式 | EditorState 直接操作 + Yjs 感知层 |
| Ghost Text | ✅ DecoratorNode 方案 |
| 内容模型 | ✅ 自定义 Node/Mark，完全可扩展 |
| 富文本编辑 | ✅ 官方支持 |
| 协作 | ✅ **Yjs 一等公民**，官方维护 `@lexical/yjs` |
| Plan Mode 支持 | ✅ **最强**：setEditable + 节点级权限 |
| 多模态 | 需自定义（无官方 Image Node，但 playground 有示例） |
| 性能 | 最优（零依赖，虚拟 DOM diffing） |
| 生态 | 较小（相比 TipTap），但 Meta 内部大规模验证 |
| 学习曲线 | 中等（比 ProseMirror 简单，比 TipTap 更底层） |

---

## 8. Lexical 的 AI 友好性总结

**不是"Meta 在用所以好"**，而是：

1. **contentEditable 分离**：AI 修改 EditorState 而不受 DOM 状态干扰，协作编辑天然友好
2. **Yjs 集成官方维护**：非第三方绑定，版本同步可靠
3. **Immutable EditorState**：任意 AI 建议可回溯、可 undo、可对比
4. **DecoratorNode**：Ghost Text 类功能有原生支持
5. **setEditable 机制**：Plan Mode 的读写分离有明确 API
6. **无 React 强制依赖**：核心引擎纯净，可嵌入任意前端框架
