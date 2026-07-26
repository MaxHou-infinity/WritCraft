# MiniMax 图像生成产品栈

> 证据等级：★★★ A级（官方API文档 + 开放平台）
> 时效：2026年7月（Image-01于2025年3月发布；Image-01-live同周期）

---

## 一、模型列表与定位

| 模型 | 能力 | 特点 | 适用场景 |
|------|------|------|---------|
| image-01 | 文生图 + 图生图 | 高保真度，电影级画质，提示词还原精准 | 通用插图、封面、场景图 |
| image-01-live | 文生图 + 画风控制 | 手绘、卡通等画风增强，支持画风参数设置 | 插画风格内容、IP角色图 |

来源：`https://platform.minimaxi.com` 模型概览 + `https://platform.minimax.io/docs/guides/models-intro`

> image-01的定位是"精准提示控制"，强调提示词与生成图像之间的高度一致性，而非通用艺术创作

---

## 二、详细定价

### 2.1 Pay-as-you-go（美元）

**来源：** `https://platform.minimax.io/docs/guides/pricing-paygo`（2026年7月）

| 模型 | 单价 | 备注 |
|------|------|------|
| image-01 | **$0.0035 / 张** | 批量生成时每张单独计费 |

> 来源：`https://pricepertoken.com/pricing-page/provider/minimax` + `https://minimax-ai.chat/docs/api`
> 确认：image-01价格为 $0.0035/image，"Official pay-as-you-go price"

### 2.2 中国大陆定价

> ⚠️ 国内定价（platform.minimaxi.com）公开文档中image-01人民币价格标注不完整，以下为第三方平台参考换算

| 来源 | 换算价格 |
|------|---------|
| 第三方平台综合 | 约 **¥0.025-0.03元/张** |
| 官方控制台（需登录确认） | 以实际显示为准 |

> **建议**：开发者在API控制台实物确认最新人民币价格，避免计价差异

### 2.3 Token Plan抵扣

> 来源：`https://platform.minimax.io/docs/guides/pricing-paygo`
> "When API-vlm is called through Token Plan, usage deducts from the included Token Plan quota according to its pay-as-you-go price."

image-01通过Token Plan扣费，抵扣比例按$0.0035/image折算为credits

---

## 三、核心能力详解

### 3.1 纵横比支持

image-01支持以下所有标准纵横比：

| 纵横比 | 格式 | 推荐场景 |
|--------|------|---------|
| 16:9 | 宽幅 | 视频封面、网页配图 |
| 4:3 | 标准 | 文章插图、PPT |
| 3:2 | 照片 | 书籍封面、摄影 |
| 2:3 | 竖幅 | 公众号封面、手机壁纸 |
| 3:4 | 竖幅 | 社交媒体 |
| 9:16 | 手机竖屏 | 短视频封面 |
| 21:9 | 电影幅 | 宽银幕场景 |

### 3.2 批量生成能力

- **每请求最大数量**：9张图像
- **系统吞吐**：10请求/分钟 或 60 tokens/分钟
- **最大并发**：9张 × 10请求 = **90张/分钟**（批处理模式）

> 来源：`https://www.aibase.com/zh/news/15905`

### 3.3 中文Prompt支持度

**评估：良好（证据充分）**

1. **官方立场**：MiniMax作为中国团队，模型训练数据中文占比较高，官方宣传材料全中文
2. **实测数据**：腾讯云开发者社区评测明确指出"中文Prompt支持好"，参考 `https://cloud.tencent.com/developer/news/2262920`
3. **OpenClaw集成验证**（2026年3月）：中文prompt生成质量稳定，集成测试通过
4. **Image-01发布公告**：强调"优越的提示与图像之间保真度"，未区分语言

**注意事项：**
- 复杂中文场景建议配合简单英文关键词（光影术语、艺术家名）
- 超长描述建议控制在500字以内，避免超出模型截断
- 人物/手部等细节仍有翻车概率，建议用negative prompt补充

---

## 四、API调用方式

### 4.1 Endpoint

| 版本 | URL |
|------|-----|
| 全球版 | `POST https://api.minimax.io/v1/image_generation` |
| 中国大陆版 | `POST https://api.minimaxi.com/v1/image_generation` |

### 4.2 请求格式

```json
{
  "model": "image-01",
  "prompt": "详细的画面描述，支持中文",
  "aspect_ratio": "16:9",
  "num_images": 1,
  "extra_params": {
    "style": "realistic",
    "negative_prompt": "不要模糊、低质量"
  }
}
```

> 来源：`https://blog.csdn.net/zhangay1998/article/details/160310931` MiniMax官方CLI教程

### 4.3 OpenClaw集成

```json
{
  "provider": "minimax",
  "model": "image-01",
  "capability": "image_generate"
}
```

> 来源：`https://docs.openclaw.ai/providers/minimax`
> minimax插件注册了image-01模型的image_generate能力，支持minimax和minimax-portal两种认证路径

---

## 五、与其他图像API对比

| 维度 | MiniMax image-01 | Midjourney | DALL-E 3 | Stable Diffusion |
|------|-----------------|-----------|---------|----------------|
| API接入 | ✅ 官方API | ❌ 需第三方 | ✅ OpenAI API | ✅ 开源自部署 |
| 中文Prompt | ✅ 好 | △ 一般 | ✅ 好 | △ 需英文 |
| 价格 | $0.0035/张 | ~$0.035/张 | ~$0.04/张 | 算力成本 |
| 速度 | 快（10 RPM） | 中 | 快 | 快（本地） |
| 艺术风格 | 中（精准导向） | 强（创意） | 中 | 取决于模型 |

> image-01定位是"精准控制"而非"创意无限"，不适合替代Midjourney做强艺术风格创作

---

## 六、典型用例（写作IDE场景）

### 场景1：章节插图自动生成
- **触发时机**：用户写作中提及场景描述 → AI识别场景类型 → 手动/自动触发
- **推荐纵横比**：16:9 或 3:2（文章配图）
- **批量策略**：先生成3张候选，用户自选
- **成本**：¥0.025-0.03/张 × 3张/篇 × 100用户 × 30天 = ¥225-270/月

### 场景2：书籍封面生成
- **触发方式**：用户提供书名/主题 → AI生成3-5张封面候选
- **推荐纵横比**：3:2（书封）或 2:3（竖版）
- **风格预设**：image-01-live更适合插画风格封面

### 场景3：角色一致性插图（IP向）
- **触发方式**：用户提供角色描述作为首图 → image-01图生图锁定角色
- **能力**：subject_reference支持角色一致性（需参考图）
- **局限**：多角色场景控制仍困难

---

## 七、优劣势总结

### 优势
- ✅ **价格仅竞品1/10**：官方宣传有据，$0.0035 vs Midjourney~$0.035
- ✅ **中文Prompt支持好**：国内用户友好，无需翻译为英文
- ✅ **批处理能力强**：最多9张/请求，适合筛选场景
- ✅ **纵横比丰富**：7种标准比例，全场景覆盖
- ✅ **图生图支持**：垫图锁定角色/风格，可控性强

### 劣势
- ❌ **强艺术风格不如Midjourney**：定位精准控制，非创意发散
- ❌ **分辨率标注不清晰**：512P/768P/1080P参数在文档中未明确标注
- ❌ **国内定价需确认**：控制台实物确认，公开文档不完整
- ❌ **复杂人体/手部仍有翻车**：需配合negative prompt使用
- ❌ **URL有效期**：若走异步获取，需注意文件URL过期时间
