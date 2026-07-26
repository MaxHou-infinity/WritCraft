# MiniMax 语音/TTS产品栈

> 证据等级：★★★ A级（官方API文档 + 开放平台 + 第三方评测机构）
> 时效：2026年7月（Speech-2.8于2025年发布；Speech-2.6同期；Speech Arena排名第一数据来自Artificial Analysis）

---

## 一、模型列表与定位

### TTS（Text-to-Speech）模型

| 模型 | 特点 | 语言支持 | 预设声音 |
|------|------|---------|---------|
| speech-2.8-hd | 情绪渲染融合语气词，广播级音质，重塑自然听感 | 40+语言 | 17+预设 |
| speech-2.8-turbo | 极速生成，更自然逼真的音频效果 | 40+语言 | 17+预设 |
| speech-2.6-hd | 极致音质与韵律表现，生成更快更自然 | 40+语言 | - |
| speech-2.6-turbo | 音质优异，超低时延，响应更灵敏 | 40+语言 | - |
| speech-02-hd | 出色韵律和稳定性，复刻相似度和音质表现突出 | 多语言 | - |
| speech-02-turbo | 小语种能力增强，性能表现出色 | 多语言 | - |

来源：`https://platform.minimax.io/docs/guides/models-intro#audio`

---

## 二、详细定价

### 2.1 Pay-as-you-go（美元）

**来源：** `https://platform.minimax.io/docs/guides/pricing-paygo`（2026年7月）

| 模型 | 单价 | 备注 |
|------|------|------|
| speech-2.8-hd | **$100** / M characters | 高清音质 |
| speech-2.8-turbo | **$60** / M characters | 高速 |
| speech-2.6-hd（同步） | **$100** / M characters | 同步接口 |
| speech-2.6-turbo（同步） | **$60** / M characters | 同步接口 |
| speech-2.6-hd（异步） | **$35** / M characters | 异步接口更优惠 |
| speech-2.6-turbo（异步） | **$20** / M characters | 异步接口最优惠 |

### 2.2 Pay-as-you-go（人民币）

**来源：** `https://platform.minimaxi.com/docs/guides/pricing-paygo`

| 模型 | 同步T2A | 异步T2A Async |
|------|---------|--------------|
| speech-2.8-hd | ¥3.5/万字符 | ¥3.5/万字符 |
| speech-2.8-turbo | ¥2.0/万字符 | ¥2.0/万字符 |
| speech-2.6-hd / speech-02-hd | ¥3.5/万字符 | ¥3.5/万字符 |
| speech-2.6-turbo / speech-02-turbo | ¥2.0/万字符 | ¥2.0/万字符 |

### 2.3 字符计数规则

> 1个汉字 = 2字符  
> 英文字母、希腊字母、标点符号、空格、回车 = 1字符

**换算参考：**
- 1,000中文字 ≈ 2,000字符 ≈ $0.06-0.10（HD/Turbo）
- 1,000中文字 ≈ 2,000字符 ≈ ¥0.40-0.70（HD/Turbo）
- 1小时中文朗读（约5万字符）≈ ¥10-17.5

### 2.4 Audio Subscription（月度订阅）

**来源：** `https://platform.minimax.io/docs/guides/pricing-speech`

| 套餐 | 月费（美元） | 年费（美元，8折） | Audio Points |
|------|------------|----------------|--------------|
| Starter | $5 | $48 | 100,000点 |
| Standard | $30 | $288 | 300,000点 |
| Professional | $99 | $950 | 1,100,000点 |
| Enterprise | $249 | $2,390 | 3,300,000点 |
| Unlimited | $999 | $9,590 | 无限 |

---

## 三、中文TTS质量评估

**评估：顶尖（有多方独立验证）**

### 3.1 权威Benchmark排名第一

| 评测机构 | 排名 | 数据来源 |
|---------|------|---------|
| Artificial Analysis Speech Arena | **#1**（盲测用户偏好） | `https://artificialanalysis.ai/text-to-speech/model-families/minimax-hailou` |
| Hugging Face TTS Arena | **#1** | `https://replicate.com/minimax/speech-2.8-hd` |

> 超过OpenAI和ElevenLabs的TTS模型（第三方盲测，非官方数据）

### 3.2 情绪标签原生支持

speech-2.8系列支持**原生声音标签（Native Sound Tags）**，是区别于竞品的关键特性：

```
(laughs)    - 笑声
(sighs)     - 叹息
(coughs)    - 咳嗽
(gasps)     - 喘息
(breath)    - 呼吸声
```

> Demo示例（来自官方）："I am the new Speech 2.8 model from MiniMax. Crazy, right?" → 带有自然的呼吸和语气词

### 3.3 中文语种支持

- 普通话（标准中文）
- 粤语
- 英语
- 日语
- 韩语
- 40+语言总计

---

## 四、Voice Library（声音库）

### 4.1 预设声音

- 17+预设voice_id，可直接通过T2A API使用
- 覆盖不同性别、年龄、音色的声音

### 4.2 自定义声音（语音克隆）

- 通过MiniMax Voice产品自定义声音
- 支持voice_id复用
- 适合IP角色固定声音、虚拟主播声线

> 语音克隆需额外开通MiniMax Voice服务，具体定价需咨询销售

### 4.3 声音选择建议

| 场景 | 推荐声音类型 |
|------|------------|
| 新闻播报 | 正式男声/女声 |
| 小说朗读 | 自然叙述声 |
| 儿童内容 | 温和童声 |
| 品牌IP | 自定义克隆声 |

---

## 五、API调用方式详解

### 5.1 Endpoint

| 类型 | 全球版 | 中国大陆版 |
|------|--------|----------|
| 同步T2A | `POST https://api.minimax.io/v1/t2a_v2` | `POST https://api.minimaxi.com/v1/t2a_v2` |
| 异步T2A | `POST https://api.minimax.io/v1/t2a_async_v2` | `POST https://api.minimaxi.com/v1/t2a_async_v2` |

### 5.2 同步请求格式

```json
{
  "model": "speech-2.8-hd",
  "text": "这是一段测试文本，支持(laughs)和(sighs)等情绪标签",
  "voice_id": "预设voice_id或自定义voice_id",
  "language": "auto",
  "emotion": "supporting",
  "output_format": "mp3"
}
```

> 来源：`https://platform.minimax.io/docs/api-reference/speech-t2a-http`

### 5.3 字符限制

| 接口 | 最大字符数 | 适用场景 |
|------|----------|---------|
| 同步T2A | 10,000字符 | 短文本、实时响应 |
| 异步T2A | 1,000,000字符 | 长文本、有声书 |

### 5.4 streaming模式

> 来源：`https://platform.minimax.io/docs/api-reference/speech-t2a-http`
> 对于超过3,000字符的文本，建议开启streaming输出

---

## 六、典型用例（写作IDE场景）

### 场景1：采访录音转文字 → AI生成朗读版
- **推荐模型**：speech-2.8-turbo（异步）
- **理由**：异步支持百万字符，适合1小时+采访；中文识别强；¥2/万字符性价比高
- **成本**：1小时采访录音（≈5万字符）≈ ¥10（Turbo版）
- **流程**：录音 → ASR转文字 → TTS生成音频 → 用户收听

### 场景2：文章朗读/听书功能
- **推荐模型**：speech-2.8-hd（同步）
- **理由**：广播级音质，情绪自然；适合长篇内容分章节生成
- **成本**：千字文章（≈1,500字符）≈ ¥0.53（HD版）或 ¥0.30（Turbo版）

### 场景3：品牌IP语音（V2功能）
- **推荐**：自定义voice_id（语音克隆）
- **理由**：WritCraft写作IP配套，固定角色声音
- **注意**：需开通MiniMax Voice服务

---

## 七、与其他TTS对比

| 维度 | MiniMax Speech-2.8 | OpenAI TTS | ElevenLabs | Azure TTS |
|------|-------------------|------------|-----------|----------|
| 中文TTS质量 | **#1**（盲测） | 强 | 强 | 强 |
| 情绪标签 | ✅ 原生支持 | ❌ | △ | ❌ |
| 价格（$/M字符） | $60-100 | ~$15 | ~$30 | ~$10-20 |
| 声音克隆 | ✅ | ❌ | ✅ | ✅ |
| 异步百万字符 | ✅ | ❌ | ❌ | ✅ |

> MiniMax Speech-2.8价格偏高（$60-100/M vs Azure~$10-20/M），但盲测质量第一，中文场景推荐优先使用

---

## 八、优劣势总结

### 优势
- ✅ **TTS盲测双榜第一**：中文自然度业界顶尖，超过OpenAI/ElevenLabs
- ✅ **情绪标签原生支持**：speech-2.8独一无二，中文更自然
- ✅ **异步百万字符**：长文本（采访/有声书）无压力
- ✅ **声音克隆能力**：IP角色配套声音
- ✅ **中文优化**：普通话+粤语+多方言支持

### 劣势
- ❌ **HD版$100/M价格较高**：是Azure TTS的5-10倍
- ❌ **Turbo版$60/M仍有溢价**：比OpenAI TTS贵4倍
- ❌ **实时语音通话非当前API范畴**：需用Realtime产品
- ❌ **声音克隆需额外开通**：非标准API能力
- ❌ **声音克隆定价未公开**：需商务询价
