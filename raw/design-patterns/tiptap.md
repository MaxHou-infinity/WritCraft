# TipTap 架构分析

> 证据等级：A（官方文档）+ B（GitHub 源码 + 社区讨论）
> 时效：2026-07-14，基于 TipTap 2.x

---

## 1. 定位：ProseMirror 的友好封装

TipTap 是 **ueberdevosis** 团队维护的 ProseMirror 上层封装，核心定位是"让 ProseMirror 变得容易使用"。它用 React（官方）和 Vue（非官方）组件封装了 ProseMirror 的四模块，同时提供了一套**声明式 Extension 扩展系统**。

```
TipTap = ProseMirror 核心 + React 组件层 + Extension 系统 + 云平台
```

**关键理解**：TipTap 不是独立的编辑器引擎，它的底层能力全部来自 ProseMirror。选择了 TipTap = 选择了 ProseMirror 的所有架构优势（Schema、可控 Transaction），同时获得更好的开发体验。

---

## 2. 核心架构：三层结构

### 2.1 Schema 层（继承自 ProseMirror）

TipTap 文档在内部存储为 ProseMirror Node 树，可通过 `editor.getJSON()` 导出：

```json
{
  "type": "doc",
  "content": [
    {
      "type": "heading",
      "attrs": { "level": 1 },
      "content": [{ "type": "text", "text": "文档标题" }]
    },
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "这是", "marks": [{ "type": "bold" }] },
        { "type": "text", "text": "内容", "marks": [{ "type": "ai-inline", "attrs": { "suggestedText": "建议文本", "status": "pending" }}]}
      ]
    }
  ]
}
```

### 2.2 Extension 扩展系统（TipTap 的核心价值）

TipTap 通过 Extension 机制扩展功能，所有内置功能（bold/italic/heading/list）均为 Extension：

```typescript
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import AIInline from 'tiptap-ai-inline-extension';  // AI 扩展

const editor = useEditor({
  extensions: [
    StarterKit,
    Image.configure({ inline: true, allowBase64: true }),
    AIInline.configure({
      apiEndpoint: '/api/ai/suggest',
      streaming: true
    })
  ],
  content: '<p>Hello WritCraft</p>'
});
```

**TipTap AI 扩展生态（2026 年现状）**：

#### AI Toolkit（官方，当前主力）

TipTap 官方提供 **AI Toolkit**，包含三个核心扩展：

1. **`@tiptap/extension-ai`**：AI 生成基础扩展，支持：
   - `aiSuggest`：选中文本后生成改写建议（逐句 diff）
   - `aiExpand`：扩展当前选区内容
   - `aiShorten`：精简当前选区
   - `aiTone`：调整语气（正式/口语/学术）

2. **`@tiptap/extension-ai-agent`**：AI Agent 扩展，允许 AI 读取和编辑文档：
   ```typescript
   const agentExtension = AIAgentExtension.create({
     tools: [
       {
         name: 'readDocument',
         description: '读取文档内容',
         execute: async () => editor.getJSON()
       },
       {
         name: 'insertParagraph',
         description: '在当前位置插入段落',
         execute: async ({ text }) => {
           editor.chain().focus().insertContent(`<p>${text}</p>`).run();
         }
       }
     ],
     model: 'claude-3-5-sonnet'
   });
   ```

3. **`@tiptap/extension-ai-chat`**：在编辑器内嵌入 AI 对话面板（类 Copilot Chat）

#### 第三方 AI 扩展

- **Novel（开源）**：Notion 风格编辑器，基于 TipTap，内置 AI 自动补全
- **Liveblocks AI Copilot**：实时协作 + AI，提供 diff accept/reject UI
- **自定义扩展**：可基于 TipTap Extension API 封装任意 AI 服务

### 2.3 React 组件层

TipTap 提供 `@tiptap/react` 绑定，核心组件：

- `<EditorContent editor={editor} />`：渲染编辑器
- `<BubbleMenu editor={editor}>`：浮动菜单（选中文字时出现）
- `<FloatingMenu editor={editor}>`：行首浮动菜单（插入块级元素）
- `<CommandMenu />`：命令面板（Cmd+K）

---

## 3. TipTap 的 AI 扩展机制详解

### 3.1 AI Suggestion（逐句 Diff）实现

基于 TipTap 的 Mark Extension 实现 AI 逐句 diff：

```typescript
import { Mark, mergeAttributes } from '@tiptap/core';

const AISuggestionMark = Mark.create({
  name: 'aiSuggestion',
  
  addAttributes() {
    return {
      originalText: { default: '' },
      suggestedText: { default: '' },
      modelId: { default: '' },
      confidence: { default: 1.0 },
      status: { default: 'pending' }  // pending | accepted | rejected
    };
  },
  
  parseHTML() {
    return [{ tag: 'span[data-ai-suggestion]' }];
  },
  
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-ai-suggestion': '',
      class: `ai-suggestion ai-suggestion--${HTMLAttributes.status}`
    }), 0];
  }
});
```

### 3.2 Ghost Text 风格实现

TipTap 本身不直接支持 Ghost Text，但可通过以下组合实现：

```typescript
// 监听补全请求 → 插入 suggestion mark → UI 层渲染灰色预览
editor.on('ai:suggestion', ({ original, suggestion }) => {
  // 在 suggestion mark 下添加临时内容
  editor.chain()
    .setMark('aiSuggestion', {
      originalText: original,
      suggestedText: suggestion.text,
      status: 'pending'
    })
    .run();
});
```

配合 CSS：
```css
.ai-suggestion--pending {
  background: rgba(200, 200, 200, 0.3);
  text-decoration: underline;
  text-decoration-style: wavy;
}
```

### 3.3 多模态：Image Extension

TipTap 内置 `@tiptap/extension-image`，支持：

```typescript
Image.configure({
  inline: true,           // 允许行内图片
  allowBase64: true,      // 支持 base64（用于本地预览）
  HTMLAttributes: {
    class: 'writcraft-figure'
  }
});
```

对于 AI 图像生成（MiniMax 生图），可扩展为：

```typescript
const AIM imageExtension = Image.extend({
  addAttributes() {
    return {
      ...this.parent(),
      generationPrompt: { default: null },
      modelId: { default: 'minimax-image' }
    };
  }
});
```

---

## 4. TipTap + Yjs 协作

TipTap 官方采用 **Yjs（CRDT）** 而非 ProseMirror 内置 OT 作为协作方案：

```typescript
import { HocuspocusProvider } from '@hocuspocus/provider';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';

const ydoc = new Y.Doc();
const provider = new HocuspocusProvider({
  url: 'ws://localhost:1234',
  name: 'writcraft-doc-1',
  document: ydoc
});

const editor = useEditor({
  extensions: [
    StarterKit.configure({ history: false }),  // 禁用 ProseMirror history，用 Yjs 替代
    Collaboration.configure({ document: ydoc }),
    CollaborationCursor.configure({
      provider,
      user: { name: 'Max', color: '#3b82f6' }
    })
  ]
});
```

**Hocuspocus**：TipTap 官方商业协作后端，支持持久化、WebSocket 实时同步、离线重连。

---

## 5. TipTap vs ProseMirror：关键区别

| 维度 | TipTap | ProseMirror |
|------|--------|------------|
| 开发体验 | 声明式 React 组件 | 底层 Lego 工具包 |
| Schema | ✅ 可配置 | ✅ 完全自定义 |
| AI 扩展 | ✅ 官方 AI Toolkit + 社区 | ❌ 需自行实现 |
| Ghost Text | 需组合实现 | 需组合实现 |
| 多模态 | ✅ Image/Table/CodeBlock 官方扩展 | ❌ 需自行实现 |
| 协作 | ✅ Yjs + Hocuspocus（官方支持） | ✅ 内置 OT |
| 学习曲线 | 中等 | 高 |
| 包体积 | 较大（React 依赖） | 轻量 |
| Plan Mode | 可实现 | 可实现 |
| 云平台 | 有官方付费平台 | 无 |

---

## 6. 对 WritCraft 的适用性评估

### 优势
- ✅ **AI 生态成熟**：官方 AI Toolkit（尽管部分功能 2026 年在 deprecate）
- ✅ **开发效率高**：React 声明式 API，快速迭代
- ✅ **协作方案完整**：Hocuspocus 官方支持，减少自建成本
- ✅ **多模态扩展**：Image（+base64）支持本地预览，与 MiniMax 生图天然配合

### 劣势
- ❌ **包体积较大**：React 依赖，对轻量场景不友好
- ❌ **AI Toolkit 部分 deprecated**：官方 2026 年在迁移到 AI Agent，部分功能不稳定
- ❌ **自定义程度受限**：相比 ProseMirror 深层次定制，TipTap 有抽象代价
- ❌ **Plan Mode 需额外开发**：Outline/Plan Mode 功能无官方扩展

### 适合场景
WritCraft V0 可考虑以 TipTap 为核心，快速验证 AI 写作体验，同时预留 ProseMirror 深层次定制能力。

---

## 7. AI 扩展开发示例（TipTap Extension）

```typescript
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export const MiniMaxSuggestExtension = Extension.create({
  name: 'minimaxSuggest',
  
  addOptions() {
    return {
      apiKey: '',
      model: 'MiniMax-Text-01',
      onSuggestion: (result) => {}
    };
  },
  
  addProseMirrorPlugins() {
    const extension = this;
    
    return [
      new Plugin({
        key: new PluginKey('minimaxSuggest'),
        props: {
          handleTextInput(view, from, to, text) {
            // 场景：用户输入句号时，触发 AI 续写建议
            if (text === '.' && extension.options.onSuggestion) {
              const precedingText = view.state.doc.textBetween(
                view.state.doc.resolve(from).start(),
                from
              );
              
              fetch('/api/ai/suggest', {
                method: 'POST',
                body: JSON.stringify({
                  text: precedingText,
                  model: extension.options.model
                })
              }).then(res => res.json())
                .then(result => {
                  extension.options.onSuggestion(result);
                });
            }
            return false;
          }
        }
      })
    ];
  }
});
```
