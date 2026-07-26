# WritCraft 写作IDE MiniMax模型分工架构

> 证据等级：★★★ A/B级混合（官方定价 + 第三方Benchmark + 社区反馈）
> 时效：2026年7月

---

## 一、核心定位：为什么 WritCraft 以 MiniMax 为主模型栈

**主人原话**：先以 MiniMax 模型入手，主要原因是有现成的生图产品

| 原因 | 说明 |
|------|------|
| 图像生成成熟 | image-01直接可用，无需自研或接入第三方 |
| 中文优化 | MiniMax全系中文理解能力强，适合中文写作场景 |
| 成本优势 | 约为GPT-4o的1/5-1/10，降低用户试错成本 |
| 国内访问 | api.minimaxi.com国内访问稳定，无跨境延迟 |
| 全栈覆盖 | 文本/图像/视频/语音/文档解析五大模态统一接入 |

---

## 二、WritCraft写作IDE模型分工矩阵

| 任务 | 推荐模型 | 优先级 | 负责人 |
|------|---------|--------|--------|
| 长文生成 / 改写 | **MiniMax-M3** | P0 | 模型层 |
| 单句⌘K修改 | **MiniMax-M2.7-highspeed** | P0 | 模型层 |
| 图像生成（章节插图/封面） | **MiniMax image-01** | P0 | 模型层 |
| 文档理解（用户上传参考资料） | **MiniMax 文档解析** | P1 | 模型层 |
| 语音转文字（采访转录） | **MiniMax 语音** | P1 | 模型层 |
| 视频生成（V1） | **MiniMax Hailuo-02** | V1规划 | 产品层 |

---

## 三、5类MiniMax模型 × 6维度完整档案

### 档案1：MiniMax-M3（旗舰文本模型）

| 维度 | 内容 |
|------|------|
| **模型名/版本** | MiniMax-M3，2026年5月31日发布（OpenRouter记录），2026年6月1日官方宣布 |
| **上下文窗口** | 1,000,000 tokens（MSA稀疏注意力，全新架构） |
| **输出速度** | ~100 tps（tokens per second） |
| **输入限制** | ≤512K享受促销价5折；>512K恢复原价 |
| **定价（≤512K，促销）** | 输入**$0.30/M**（原价$0.60）；输出**$1.20/M**（原价$2.40）；缓存读取$0.06/M |
| **定价（>512K，原价）** | 输入**$0.60/M**；输出**$2.40/M** |
| **API Endpoint** | `https://api.minimax.io/v1`（全球）；`https://api.minimaxi.com/v1`（中国大陆） |
| **SDK** | Anthropic SDK（推荐，工具调用）；OpenAI SDK（兼容） |
| **典型用例** | 长篇小说全文改写、多文档对比分析、Agent多步工作流 |
| **核心优势** | 1M上下文无人能敌；Coding/Agent顶尖；原生多模态输入 |
| **核心劣势** | >512K输入价格翻倍；创意发散弱于Claude 3.5 Sonnet |

### 档案2：MiniMax-M2.7-highspeed（极速文本模型）

| 维度 | 内容 |
|------|------|
| **模型名/版本** | MiniMax-M2.7-highspeed，M2.7极速版（与M2.7效果完全一致） |
| **上下文窗口** | 204,800 tokens |
| **输出速度** | ~100 tps |
| **延迟** | <200ms（实测延迟，体感接近本地词典） |
| **定价** | 输入**$0.60/M**（¥4.2/M）；输出**$2.40/M**（¥16.8/M）；缓存读取$0.06/M |
| **API Endpoint** | 同M3 |
| **典型用例** | 写作IDE单句修改（⌘K）、实时语法检查、inline修改建议 |
| **核心优势** | 极速响应<200ms；中文改写精准；实时交互体验好 |
| **核心劣势** | 上下文窗口小于M3（204K vs 1M）；价格是M2.7标准版的2倍 |

### 档案3：MiniMax image-01（图像生成）

| 维度 | 内容 |
|------|------|
| **模型名/版本** | image-01（2025年3月发布）；image-01-live（同周期，手绘/卡通增强） |
| **核心能力** | 文生图 + 图生图（垫图锁定角色）；7种标准纵横比；最多9张/请求 |
| **输入限制** | Prompt建议≤500字；系统吞吐量60 tokens/分钟 |
| **定价** | **$0.0035/张**（约¥0.025-0.03/张，控制台确认）；Token Plan可抵扣 |
| **API Endpoint** | `https://api.minimax.io/v1/image_generation` |
| **中文Prompt** | 良好（MiniMax祖传中文优化，国内团队） |
| **典型用例** | 章节插图、书籍封面、角色垫图（IP向） |
| **核心优势** | 价格为竞品1/10；中文Prompt好；批处理9张/请求 |
| **核心劣势** | 强艺术风格不如Midjourney；分辨率参数标注不清晰 |

### 档案4：MiniMax Speech-2.8（语音合成）

| 维度 | 内容 |
|------|------|
| **模型名/版本** | speech-2.8-hd（高清）；speech-2.8-turbo（高速）；2025年发布 |
| **核心能力** | 文字转语音；情绪标签（laughs/sighs等）；40+语言；17+预设声音 |
| **输入限制** | 同步10,000字符/请求；异步1,000,000字符/请求 |
| **定价（Turbo）** | $60/M字符（¥2.0/万字符） |
| **定价（HD）** | $100/M字符（¥3.5/万字符） |
| **中文TTS质量** | **Artificial Analysis Speech Arena #1**（盲测，超过OpenAI/ElevenLabs） |
| **API Endpoint** | `https://api.minimax.io/v1/t2a_v2`（同步）；`/v1/t2a_async_v2`（异步） |
| **典型用例** | 采访录音→音频回放；文章朗读/听书；IP角色固定声线 |
| **核心优势** | TTS盲测双榜第一；情绪标签独一无二；中文自然度极高 |
| **核心劣势** | $60-100/M价格较高（Azure TTS约$10-20/M）；声音克隆需额外开通 |

### 档案5：MiniMax 文档解析（文件理解）

| 维度 | 内容 |
|------|------|
| **模型** | MiniMax-Text-01（隐式调用，通过对话接口） |
| **支持格式** | PDF、DOCX、TXT、JSONL（Markdown需实测确认） |
| **OCR能力** | **无**（扫描件/图片型PDF需前置OCR处理） |
| **定价** | 参考API-VLM：**$0.06/请求**（具体以控制台为准） |
| **API架构** | 两步走：1）文件上传获取file_id；2）带file_id的对话请求 |
| **API Endpoint** | `POST /v1/files/upload` + `POST /v1/text/chatcompletion_v2` |
| **典型用例** | 用户上传参考文档（PDF/Word），AI深度理解后注入上下文 |
| **核心优势** | 多格式支持；MiniMax-Text-01深度理解（非简单OCR） |
| **核心劣势** | Markdown未明确支持；OCR能力弱；定价需确认 |

---

## 四、5个"用MiniMax比用其他家更优"的具体场景

### 场景1：中文长文写作 → 用MiniMax-M3，不用GPT-4o
**真实案例：中文小说/文章续写**

- MiniMax-M3（1M上下文）可一次性注入整本书前半部分，实现跨章节人物线追踪
- GPT-4o上下文窗口有限（128K），长文需分段处理，增加系统复杂度
- 成本：M3长文改写约¥0.01-0.05/千字，GPT-4o同等质量约¥0.2-0.5/千字
- **结论：MiniMax成本约为GPT-4o的1/10，中文质量相近**

### 场景2：实时单句修改 → 用MiniMax-M2.7-highspeed，不用Claude 3.5 Haiku
**真实案例：IDE⌘K内联修改**

- M2.7-highspeed延迟<200ms，用户输入完即刻看到修改建议，体感接近本地词典
- Claude 3.5 Haiku虽快，但中文改写精确度不如M2.7-highspeed（开发者社区反馈）
- 中文短文本（单句级别），M2.7-highspeed已经"够好"，无需上Claude Opus
- **结论：极速+精准+低价，中文单句修改场景MiniMax胜出**

### 场景3：章节插图 → 用MiniMax image-01，不用Midjourney
**真实案例：小说章节配图生成**

- image-01 API成本$0.0035/张≈¥0.025/张，Midjourney高速模式约$0.035/张
- MiniMax中文Prompt理解更精准，国产应用集成更便捷（无跨境API延迟）
- 主人原话："有现成的生图产品"——直接可用，减少接入成本和调试时间
- **结论：成本、速度、中文支持三方面MiniMax均优**

### 场景4：采访转录 → 用MiniMax Speech-2.8-turbo，不用Azure TTS
**真实案例：采访录音转文字后生成音频回放**

- MiniMax中文TTS盲测第一（Artificial Analysis + Hugging Face双榜），超过OpenAI和ElevenLabs
- ¥2/万字符（Turbo版），Azure TTS中文约¥15/万字符
- 情绪标签支持（laughs/sighs等），中文自然度高
- **结论：中文TTS场景MiniMax质量第一+价格优，仅语音合成质量有要求时可选**

### 场景5：长PDF合同分析 → 用MiniMax文档解析，不用Claude
**真实案例：用户上传参考合同，AI提炼关键条款**

- MiniMax文档解析（走MiniMax-Text-01）成本约$0.06/请求
- Claude合同分析走对话接口，按token计费，复杂合同（5万字）约$0.015-0.03/次
- 两者价格相近，但MiniMax国内访问更快（无跨境延迟）
- **结论：国内访问稳定+价格相近，文档解析场景MiniMax可作为首选**

---

## 五、4个"不要用MiniMax"的红线场景

### ❌ 强推理任务 → 用OpenAI o1 / Claude Opus
- MiniMax M系列在复杂数学证明、多步逻辑推理上不如o1/Opus
- Coding极限能力（SWE-Bench Verified 78%）接近Opus，但**非超越**
- 强推理场景建议：o1用于复杂推理，Claude Opus用于深度分析

### ❌ 极长上下文（>1M tokens）→ 用Gemini 1.5 Pro 2M
- MiniMax M3上下文上限1M；Gemini 1.5 Pro支持2M
- 若 WritCraft V2 支持超长文学分析（如完整书库对比），需引入Gemini
- 备选：Claude Opus 200K（次选）

### ❌ 多模态实时交互 → 用GPT-4o real-time
- GPT-4o real-time支持语音/视觉实时对话
- MiniMax当前API均为异步/同步单次调用，无真实实时会话能力
- 实时语音交互场景：建议用GPT-4o或专有语音方案

### ❌ 创意极限发散 → 用Claude 3.5 Sonnet
- Sonnet的创意发散（脑暴、故事走向探索）强于MiniMax
- MiniMax偏向精准指令遵循，创意自由度略低
- 建议：故事大纲/创意探索用Claude 3.5 Sonnet，正文写作切回MiniMax

---

## 六、成本估算（V0 100用户内测1个月）

**假设：100用户，日均消耗估算**

| 模态 | 日均消耗 | 月总量 | 单价（美元） | 月成本（美元） | 月成本（人民币） |
|------|---------|--------|------------|--------------|----------------|
| 文本-对话（M3≤512K） | 500 tokens/人/天 | 1.5M tokens | $0.30/M输入 | ~$15-30 | ~¥110-220 |
| 文本-⌘K修改（M2.7-hs） | 50次/人 × 50 tokens | 75M tokens（输入） | $0.60/M | ~$45 | ~¥330 |
| 图像生成 | 2张/人/天 | 6,000张 | $0.0035/张 | ~$21 | ~¥150 |
| 文档解析 | 0.5次/人/天 | 1,500次 | $0.06/次 | ~$90 | ~¥660 |
| 语音TTS（Turbo估算） | 0（V0暂非核心） | - | - | - | - |
| **总计** | | | | **~$170-190/月** | **¥1,250-1,400/月** |

> 注意：文本对话成本假设输入:输出=1:1；文档解析按$0.06/次（VLM基准，实际可能不同）；实际消耗因用户行为差异浮动

**参考对比（同等规模）：**
- 纯用GPT-4o API：约$500-800/月（仅文本）
- 纯用Claude Opus：约$800-1200/月（仅文本）
- MiniMax全栈方案：约$170-190/月

**结论：MiniMax方案月成本约为海外主流方案的1/4-1/5**

---

## 七、关键风险与Fallback方案

### 风险1：MiniMax API挂了怎么办？

**Fallback链（优先级顺序）：**

| 模态 | Fallback #1 | Fallback #2 |
|------|------------|------------|
| 文本-对话 | DeepSeek-V3（¥0.1/M输入，国内稳定） | 通义千问（阿里云，国内稳定） |
| 图像生成 | 通义万相（阿里云，国内稳定） | 腾讯云混元图片 |
| 语音合成 | 腾讯云Hunyuan TTS | 阿里云通义语音 |
| 文档解析 | 腾讯云Hunyuan OCR + DeepSeek文本 | 有道智云PDF转换 |

### 风险2：MiniMax涨价（M3路线图显示有涨价预期）

- M3已于2026年5月发布，根据路线图（M3爆料源）**涨价在即**
- 当前促销5折随时可能恢复原价（$0.60→$0.30）
- **建议**：用量稳定时提前锁定Token Plan（$10/月起步），控制成本上限

### 风险3：中文Prompt在image-01上效果不稳定

- **建议**：重要场合（封面）先生成3-5张候选，用户自选
- 避免极复杂构图描述，拆解为多个简单描述组合
- 预留人工干预入口

### 风险4：文档解析Markdown不支持

- **建议**：V0阶段仅支持PDF/DOCX/TXT，Markdown作为P2需求
- 上线前做多格式实测，明确支持边界

---

## 八、MiniMax战略价值评估

### 8.1 MiniMax的战略位置

MiniMax是WritCraft的**默认基座模型**，但不是**唯一选择**。设计原则：
- V0阶段：MiniMax为主，文本/图像/语音覆盖核心场景
- V1阶段：引入视频、文档解析深化
- V2阶段：根据Gemini/Claude/DeepSeek技术进展，动态调整模型分层

### 8.2 为什么不是"唯一选择"

| 考量 | 说明 |
|------|------|
| 单一供应商风险 | API稳定性、价格波动、地区合规均存在风险 |
| 能力边界 | 强推理、极长上下文、创意发散等场景MiniMax不擅长 |
| 竞争态势 | MiniMax与OpenAI/Anthropic仍有差距，需保持技术跟进 |

---

## 九、数据源完整清单

| # | 来源 | URL | 时效 | 核心数据 |
|---|------|-----|------|----------|
| 1 | MiniMax官方API定价（美元） | `https://platform.minimax.io/docs/guides/pricing-paygo` | 2026年7月 | M3/M2.7文本、Speech、Music定价 |
| 2 | MiniMax官方API定价（人民币） | `https://platform.minimaxi.com/docs/guides/pricing-paygo` | 2026年7月 | 国内定价、T2A中文计价 |
| 3 | MiniMax API概览（全球） | `https://platform.minimax.io/docs/api-reference/api-overview` | 2026年7月 | 模型列表、上下文、接口描述 |
| 4 | MiniMax接口概览（中国站） | `https://platform.minimaxi.com/docs/api-reference/api-overview` | 2026年7月 | 国内接口、文档格式支持 |
| 5 | MiniMax模型介绍（全球） | `https://platform.minimax.io/docs/guides/models-intro` | 2026年7月 | 全模态模型列表 |
| 6 | MiniMax视频生成API发布 | `https://www.minimaxi.com/news/%E8%A7%86%E9%A2%91%E7%94%9F%E6%88%90api%E6%AD%A3%E5%BC%8F%E5%8F%91%E5%B8%83` | 2025年 | 异步调用流程 |
| 7 | Video Packages定价 | `https://platform.minimax.io/docs/guides/pricing-video` | 2026年7月 | 点数套餐、消耗规则 |
| 8 | Audio Subscription | `https://platform.minimax.io/docs/guides/pricing-speech` | 2026年7月 | 语音月度订阅方案 |
| 9 | MiniMax Speech 2.8发布 | `https://www.minimax.io/news/minimax-speech-28` | 2025年 | 情绪标签、中文TTS能力 |
| 10 | Speech 2.8 HD Replicate | `https://replicate.com/minimax/speech-2.8-hd` | 2026年 | TTS盲测排名第一 |
| 11 | Image-01发布（AIBase） | `https://www.aibase.com/zh/news/15905` | 2025年3月 | image-01定位、价格宣传 |
| 12 | Image-01定价确认 | `https://pricepertoken.com/pricing-page/provider/minimax` | 2026年7月 | $0.0035/image确认 |
| 13 | MiniMax文档解析GitHub | `https://github.com/MiniMax-AI/MiniMax-01/issues/25` | 2026年 | PDF上传+分析代码 |
| 14 | MiniMax OpenClaw Provider | `https://docs.openclaw.ai/providers/minimax` | 2026年 | minimax插件能力 |
| 15 | M2.7 vs Claude对比 | `https://aithinkerlab.com/minimax-m2-7-vs-gpt4-claude-benchmarks` | 2026年6月 | 性能/价格对比 |
| 16 | M1&M2.5 vs Claude/GPT | `https://bytebot.io/articles/minimax-m1-m2-5-developer-comparison` | 2026年 | SWE-Bench 80.2%数据 |
| 17 | MiniMax M3路线图 | `https://www.openai-hub.com/news/477` | 2026年3-6月 | 涨价预期、多模态融合 |
| 18 | Hailuo-02 PPIO上线 | `https://ppio.com/blogs/post/ppioshang-xian-minimax-hailuo-02-quan-qiu-pai-ming-di-er-de-shi-pin-mo-xing` | 2025年 | 视频规格、定价 |
| 19 | MiniMax官方CLI教程 | `https://blog.csdn.net/zhangay1998/article/details/160310931` | 2026年 | API调用代码 |
| 20 | MiniMax Token Plan | `https://platform.minimax.io/docs/guides/pricing-token-plan` | 2026年7月 | 订阅方案 |
| 21 | Artificial Analysis TTS | `https://artificialanalysis.ai/text-to-speech/model-families/minimax-hailou` | 2026年 | TTS Arena排名 |
| 22 | MiniMax概览（腾讯云社区） | `https://cloud.tencent.com/developer/news/2262920` | 2025年 | Image-01中文评测 |
| 23 | MiniMax M2 vs GPT-4o vs Claude 3.5 | `https://skywork.ai/blog/llm/minimax-m2-vs-gpt-4o-vs-claude-3-5-benchmark-2025` | 2025年 | 中文写作Benchmark |
