# MiniMax 文本模型产品栈

> 证据等级：★★★ A级（官方API文档 + 开放平台定价页）
> 时效：2026年7月（MiniMax-M3于2026年5月31日发布，OpenRouter记录）

---

## 一、M系列语言模型总览

| 模型 | 上下文窗口 | 输出速度 | 定位 |
|------|-----------|---------|------|
| MiniMax-M3 | 1,000,000 tokens | ~100 tps | 前沿Coding/Agent模型，原生多模态，MSA稀疏注意力 |
| MiniMax-M2.7-highspeed | 204,800 tokens | ~100 tps | M2.7同效果，延迟<200ms，实时交互首选 |
| MiniMax-M2.7 | 204,800 tokens | ~60 tps | 中高强度推理，主流之选 |
| MiniMax-M2.5 | 204,800 tokens | ~60 tps | 高性价比，复杂任务，MIT开源协议 |
| MiniMax-M2.1 | 204,800 tokens | ~60 tps | 多语言编程，代码生成优化 |

> **关于M2.5的开源声明**：MiniMax M2.5于2026年2月发布，权重开源（MIT协议），激活参数仅10B，但SWE-Bench Verified达80.2%，可直接部署
> 参考：`https://bytebot.io/articles/minimax-m1-m2-5-developer-comparison`

---

## 二、详细定价

**美元计价来源：** `https://platform.minimax.io/docs/guides/pricing-paygo`  
**人民币计价来源：** `https://platform.minimaxi.com/docs/guides/pricing-paygo`

### 2.1 MiniMax-M3（永久5折促销中）

> 注意：M3原价$0.60/$2.40，当前促销价5折后$0.30/$1.20，优惠为永久性质，但仅限≤512K输入

| 计费项 | 美元原价 | 美元促销价 | 人民币原价 | 人民币促销价 |
|--------|---------|---------|----------|------------|
| 输入（≤512K tokens） | ~~$0.60~~ | **$0.30** / M | ~~¥4.20~~ | **¥2.10** / M |
| 输出 | ~~$2.40~~ | **$1.20** / M | ~~¥16.80~~ | **¥8.40** / M |
| 缓存读取（Cache Read） | ~~$0.12~~ | **$0.06** / M | ~~¥0.84~~ | **¥0.42** / M |

> ⚠️ 超过512K的输入按原价计算，不再享受5折优惠

### 2.2 MiniMax-M2.7 / M2.5 / M2.1

| 计费项 | 美元 | 人民币 |
|--------|------|--------|
| 输入 | **$0.30** / M tokens | **¥2.10** / M tokens |
| 输出 | **$1.20** / M tokens | **¥8.40** / M tokens |
| 缓存读取 | **$0.06** / M tokens | **¥0.42** / M tokens |
| 缓存写入 | **$0.375** / M tokens | **¥2.625** / M tokens |

### 2.3 MiniMax-M2.7-highspeed（极速版）

> 效果与M2.7相同，但输出速度提升至~100 tps，适合实时交互

| 计费项 | 美元 | 人民币 |
|--------|------|--------|
| 输入 | **$0.60** / M tokens | **¥4.20** / M tokens |
| 输出 | **$2.40** / M tokens | **¥16.80** / M tokens |
| 缓存读取 | **$0.06** / M tokens | **¥0.42** / M tokens |
| 缓存写入 | **$0.375** / M tokens | **¥2.625** / M tokens |

> ⚠️ 注意：highspeed版输入价格是标准版的2倍（$0.60 vs $0.30），输出也是2倍（$2.40 vs $1.20）。适用于对延迟要求高、愿意为速度付费的场景

---

## 三、上下文窗口与Token限制

| 模型 | 最大上下文 | 最大输出 | 备注 |
|------|----------|---------|------|
| M3 | 1,000,000 tokens | 未明确标注 | MSA稀疏注意力，支持超长上下文 |
| M2.7 | 204,800 tokens | ~4,096 tokens | 开启自我迭代模式 |
| M2.7-highspeed | 204,800 tokens | 同M2.7 | 速度优先 |
| M2.5 | 204,800 tokens | ~4,096 tokens | 高性价比 |
| M2.1 | 204,800 tokens | ~4,096 tokens | 多语言优化 |

---

## 四、API调用方式详解

### 4.1 Endpoint

| 版本 | Base URL |
|------|----------|
| 全球版 | `https://api.minimax.io/v1` |
| 中国大陆版 | `https://api.minimaxi.com/v1` |

> ⚠️ 中国大陆开发者需使用minimaxi.com版本，两个版本API Key不通用，需分别注册

### 4.2 认证方式

```bash
curl -X POST https://api.minimax.io/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "MiniMax-M3", "messages": [...]}'
```

**获取方式：**
- Pay-as-you-go：控制台 → API Keys → 创建新密钥
- Token Plan：订阅管理 → Token Plan → 查看订阅Key（独立于API Key）

### 4.3 SDK接入方式

**Anthropic SDK（推荐，用于Agent工作流）**
```python
from anthropic import Anthropic
client = Anthropic(api_key="YOUR_API_KEY", base_url="https://api.minimax.io")
```

**OpenAI SDK（兼容模式）**
```python
from openai import OpenAI
client = OpenAI(api_key="YOUR_API_KEY", base_url="https://api.minimax.io/v1")
```

### 4.4 模型ID速查

| 模型 | model字段值 |
|------|-----------|
| M3 | `MiniMax-M3` |
| M2.7 | `MiniMax-M2.7` |
| M2.7-highspeed | `MiniMax-M2.7-highspeed` |
| M2.5 | `MiniMax-M2.5` |
| M2.5-highspeed | `MiniMax-M2.5-highspeed` |
| M2.1 | `MiniMax-M2.1` |
| M2.1-highspeed | `MiniMax-M2.1-highspeed` |

---

## 五、第三方Benchmark对比

**来源：** `https://aithinkerlab.com/minimax-m2-7-vs-gpt4-claude-benchmarks`（2026年6月）

### M2.7 vs Claude Opus 4.6 vs GPT-4

| 指标 | MiniMax-M2.7 | Claude Opus 4.6 | GPT-4o |
|------|-------------|----------------|--------|
| SWE-Pro | 56.22% | 略高 | 低于 |
| SWE-Bench Verified | ~78% | 基准 | 低于 |
| 价格（$/M输出） | $1.20 | ~$25 | ~$15 |
| 性价比 | 极高 | 低 | 中 |

> MiniMax M2.7输出速度（60 tps）与Opus相近，但成本仅为1/20
> M2.5成绩更突出：SWEBench Verified 80.2%，MIT协议开源

### 中文写作任务评估

来源：`https://skywork.ai/blog/llm/minimax-m2-vs-gpt-4o-vs-claude-3-5-benchmark-2025`

| 场景 | MiniMax评价 |
|------|-----------|
| 中文内容生成 | 强，中文语感自然 |
| 短文本修改 | 强，速度快 |
| 长上下文分析 | 中（204K vs Claude 200K略低） |
| 创意发散写作 | 中，不如同代Claude Sonnet |

---

## 六、典型用例（写作IDE场景）

### 场景1：长文生成与改写
- **推荐模型**：MiniMax-M3
- **理由**：
  - 1M上下文窗口，可一次性注入全文上下文进行改写，无需分段
  - Coding/Agent能力顶尖，可执行复杂的多步改写指令
  - 中文理解能力强，适合中文长文写作
- **成本估算**：
  - 千字文章约消耗 800-1,500 tokens输入 + 800 tokens输出
  - 约 ¥0.003-0.006 / 篇（M3促销价）

### 场景2：单句⌘K修改（Inline Edit）
- **推荐模型**：MiniMax-M2.7-highspeed
- **理由**：
  - 延迟<200ms，接近实时响应，IDE体验流畅
  - 中文化短文本效果好，专门针对中文写作优化
  - 价格合理（¥4.2/M输入，¥16.8/M输出）
- **成本估算**：
  - 单次修改约消耗 50-200 tokens
  - 约 ¥0.0001-0.0004 / 次

### 场景3：Agent工作流（工具调用）
- **推荐模型**：MiniMax-M3
- **理由**：原生支持Anthropic SDK工具调用（Function Calling），Agent推理能力最强
- **典型任务**：自动搜索 → 总结 → 改写 → 生成配图的一站式工作流

---

## 七、优劣势总结

### 优势
- ✅ **中文顶尖**：中文理解与生成能力强，中文写作任务首选
- ✅ **性价比极高**：M2.7约GPT-4o的1/10价格，Claude Opus的1/20价格
- ✅ **极速响应**：M2.7-highspeed延迟<200ms，实时交互无压力
- ✅ **超长上下文**：M3拥有1M上下文，长文档处理无对手
- ✅ **工具调用友好**：Anthropic SDK原生支持，Agent工作流成熟
- ✅ **价格透明**：标准Pay-as-you-go，无最低消费，无隐藏费用

### 劣势
- ❌ **M3超长输入成本翻倍**：超过512K后原价$0.60/M，性价比下降
- ❌ **输出有截断**：复杂长文可能需要分段处理
- ❌ **创意极限发散弱**：脑暴、故事走向探索不如Claude 3.5 Sonnet
- ❌ **强推理任务不如o1**：复杂数学证明、多步逻辑推理有差距
- ❌ **极长上下文（>1M）无解**：Gemini 1.5 Pro有2M上下文优势

---

## 八、M3涨价风险提示

> 来源：`https://www.openai-hub.com/news/477`（MiniMax路线图爆料，2026年3-6月）

根据MiniMax管理层内部消息：
- M3系列涨价在计划内，当前促销价为"永久5折"，**随时可能恢复原价**
- 多模态API毛利率约60-70%，文本API毛利率约40%
- **建议**：若用量稳定，可考虑提前锁定Token Plan（$10/月起步），控制成本上限
