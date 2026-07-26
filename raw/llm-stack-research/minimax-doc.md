# MiniMax 文档解析产品栈

> 证据等级：★★☆ B级（GitHub Issue + API文档交叉验证，官方文档描述有限，部分细节待实测）
> 时效：2026年7月（文档解析能力随MiniMax-Text-01发布，2025年）

---

## 一、支持的文件格式

**来源：** `https://platform.minimaxi.com/docs/api-reference/api-overview`

```
支持格式：pdf、docx、txt、jsonl
```

### ⚠️ 重要警告

1. **Markdown格式（.md）官方未被明确列出**，建议在使用前做实测验证
2. **表格/图表密集型文档**：MiniMax无明确端点，需前置处理
3. **扫描件/图片型PDF**：MiniMax不具备OCR能力，需配合OCR服务

---

## 二、文档解析架构：两步走

MiniMax文档解析采用**串联式双接口**架构，不是单一文档解析端点：

### Step 1：文件上传 → 获取file_id

```bash
POST https://api.minimaxi.com/v1/files/upload
Authorization: Bearer <API_KEY>
Content-Type: multipart/form-data

purpose: retrieval    # 用于检索/理解
file: <文件二进制>
```

**响应：**
```json
{
  "base_resp": { "status_code": 0 },
  "file": { "file_id": "xxxxxxxx" }
}
```

> ⚠️ purpose参数必须设为`retrieval`，否则无法用于后续对话理解
> 来源：GitHub Issue `https://github.com/MiniMax-AI/MiniMax-01/issues/25`

### Step 2：带document_id的对话请求 → MiniMax-Text-01理解

```bash
POST https://api.minimaxi.com/v1/text/chatcompletion_v2
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "model": "MiniMax-Text-01",
  "messages": [
    {"role": "system", "content": "file_id=<document_id>"},
    {"role": "user", "content": "请分析这个文档的主要内容，总结核心观点"}
  ],
  "temperature": 0.1,
  "stream": false
}
```

> 关键：system消息中必须包含`file_id=<document_id>`，这是MiniMax-Text-01理解文档的触发方式

---

## 三、定价说明

### ⚠️ 重要警告（任务要求明确标注）

> MiniMax实际费率必须查最新API文档，以下数据可能已过时

**已知定价参考：**

| 计费项 | 价格 | 来源 |
|--------|------|------|
| API-VLM（视觉语言模型调用） | $0.06/请求 | `https://platform.minimax.io/docs/guides/pricing-paygo` |

**说明：**
- MiniMax-Text-01文档解析不单独计费，走VLM请求配额
- 具体按"请求次数"还是"处理页数"计费，官方文档**未明确标注**
- **建议**：在platform.minimaxi.com控制台实物确认最新计费规则

### Token Plan抵扣

> 来源：`https://platform.minimax.io/docs/guides/pricing-paygo`
> "When API-vlm is called through Token Plan, usage deducts from the included Token Plan quota according to its pay-as-you-go price."

文档解析通过Token Plan扣费，按VLM的$0.06/请求折算

---

## 四、OCR能力评估

**评估：有限/缺失**

MiniMax文档解析的官方定位是**长文档内容理解**（通过MiniMax-Text-01），而非专门的OCR识别。

| 场景 | MiniMax能力 | 推荐替代方案 |
|------|------------|------------|
| 文字型PDF分析 | ✅ 支持 | - |
| Word文档分析 | ✅ 支持（docx） | - |
| 扫描件/图片型PDF | ❌ 不支持 | 腾讯云Hunyuan OCR、有道智云 |
| 表格密集型PDF | △ 有限 | 专门表格识别服务 |
| 图表/图片提取 | ❌ 无独立端点 | 配合CV服务 |

> ⚠️ 若用户上传扫描件，MiniMax会直接"看不见"文字内容，需前置OCR处理

---

## 五、文档大小与格式限制

| 项目 | 限制 | 备注 |
|------|------|------|
| 单文件大小 | 官方未明文标注 | 建议<50MB |
| 支持格式 | pdf、docx、txt、jsonl | Markdown需实测 |
| 最大页数 | 未标注 | 长文档建议实测 |

> **实测建议**：首次使用时准备不同格式（PDF/DOCX/TXT/MD）各一份，实测解析效果后再决定支持列表

---

## 六、API端点汇总

| 功能 | Endpoint | 方法 |
|------|---------|------|
| 文件上传 | `/v1/files/upload` | POST |
| 查询文件 | `/v1/files/retrieve?file_id=xxx` | GET |
| 删除文件 | `/v1/files/delete?file_id=xxx` | GET |
| 文档对话 | `/v1/text/chatcompletion_v2` | POST |

来源：`https://platform.minimaxi.com/docs/api-reference/api-overview`

---

## 七、典型用例（写作IDE场景）

### 场景1：用户上传参考文档（PDF）
- **流程**：上传PDF → MiniMax-Text-01理解 → 提取关键信息 → 注入写作上下文
- **适用**：用户提供参考报告/文章/合同，AI提炼要点辅助写作
- **限制**：PDF需为文字型，扫描件需先OCR

### 场景2：长篇小说参考（DOCX）
- **流程**：上传DOCX → AI分析人物关系/剧情线 → 辅助续写
- **优势**：MiniMax-Text-01上下文理解深
- **注意**：Markdown格式建议先转为TXT测试

### 场景3：用户上传历史文章参考（TXT）
- **流程**：上传TXT → AI学习风格 → 生成同风格内容
- **优势**：TXT格式最稳定，无需格式转换
- **成本**：VLM $0.06/次，长文本可能产生额外token费用

---

## 八、优劣势总结

### 优势
- ✅ **多格式支持**：PDF、DOCX、TXT、JSONL覆盖主流文档
- ✅ **MiniMax-Text-01深度理解**：非简单文字提取，可回答问题
- ✅ **两步式架构灵活**：文件管理接口统一，可复用file_id
- ✅ **中文理解强**：MiniMax祖传优势

### 劣势
- ❌ **Markdown格式未明确支持**：需实测确认
- ❌ **OCR能力缺失**：扫描件/图片型PDF无法处理
- ❌ **定价信息不透明**：$0.06/请求为VLM基准，文档解析具体价格需确认
- ❌ **无独立文档解析API**：必须走对话接口，prompt设计有门槛
- ❌ **表格/图表处理能力未知**：复杂版式文档效果不稳定
- ❌ **URL有效期**：文件上传后的下载URL可能有过期时间
