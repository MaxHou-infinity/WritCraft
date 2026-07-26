# MiniMax 视频生成产品栈

> 证据等级：★★★ A级（官方API文档 + 开放平台 + 新闻公告）
> 时效：2026年7月（Hailuo 02于2025年发布；Hailuo 2.3于2025年10月发布；Hailuo 3路线图2026年6月）

---

## 一、模型列表与规格

| 模型 | 能力 | 时长 | 分辨率 | 特点 |
|------|------|------|--------|------|
| MiniMax-Hailuo-02 | 文生视频 + 图生视频 | 6s（768P/1080P）或 10s（768P） | 原生1080P | SOTA指令遵循，极致物理表现 |
| MiniMax-Hailuo-2.3 | 文生视频 + 图生视频 | 5-6s（标准），最长10s | 768P | 肢体动作、面部表情突破 |
| MiniMax-Hailuo-2.3-Fast | 图生视频 | 5-6s | 768P | 更快更优惠，消耗点数更少 |

> V0阶段（WritCraft V0）暂不接入视频生成能力；V1需要时应提前确认API稳定性

来源：`https://platform.minimax.io/docs/guides/models-intro#video` + `https://www.minimaxi.com/news/%E8%A7%86%E9%A2%91%E7%94%9F%E6%88%90api%E6%AD%A3%E5%BC%8F%E5%8F%91%E5%B8%83`

---

## 二、技术亮点

### 2.1 Hailuo 02（最新旗舰）

来源：`https://ppio.com/blogs/post/ppioshang-xian-minimax-hailuo-02-quan-qiu-pai-ming-di-er-de-shi-pin-mo-xing`

- **原生1080P**：区别于其他模型的upscaled 1080P，Hailuo 02原生输出1080P
- **顶尖指令遵循**：Artificial Analysis图生视频排行榜**第二名**
- **极端物理场景处理**：可处理特技表演等复杂肢体动作
- **图生视频**：支持角色一致性视频生成

### 2.2 Hailuo 2.3

- **肢体动作突破**：面部表情、物理表现、指令遵循再度提升
- **5.9亿条视频训练数据**：大规模反馈信号优化模型
- **肢体动作精准**：区别于竞品的模糊运动

### 2.3 Hailuo 3路线图

来源：`https://www.openai-hub.com/news/477`（MiniMax内部消息，2026年3-6月）

- 预计2026年6月发布
- 基于"原生理解生成架构"
- 对标字节跳动Seedance 2.0
- 管理层透露涨价在即，多模态API毛利率已达60-70%

---

## 三、详细定价

### 3.1 Video Points套餐（美元月度订阅）

**来源：** `https://platform.minimax.io/docs/guides/pricing-video`

| 套餐 | 月费 | 总点数 | RPM限制 | 特点 |
|------|------|--------|--------|------|
| Starter | $5 | 3,760点 | 20 RPM | 支持全部视频模型 |
| Standard | $30 | 9,920点 | 30 RPM | - |
| Professional | $99 | 18,900点 | 40 RPM | - |
| Enterprise | $249 | 26,780点 | 50 RPM | 优先访问更新 |
| Unlimited | $999 | 不限 | 不限 | 安全稳定性保证 |

### 3.2 点数消耗规则

| 模型 | 分辨率/时长 | 单次消耗 |
|------|-----------|---------|
| Hailuo-2.3-Fast | 768P，6s | **0.7点** |
| Hailuo-2.3 | 768P，6s | **1点** |
| Hailuo-02 | 768P，6s | **1点** |
| Hailuo-02 | 512P，6s | **0.3点** |
| Hailuo-02 | 1080P，6s | 需查控制台 |

### 3.3 第三方平台参考（PPIO换算）

来源：`https://ppio.com/blogs/post/ppioshang-xian-minimax-hailuo-02-quan-qiu-pai-ming-di-er-de-shi-pin-mo-xing`

- Hailuo-02，10s 1080P：**￥3.6/个**

### 3.4 单次成本估算

按Enterprise套餐（$249/月，26,780点）：
- Hailuo-2.3-Fast 768P 6s ≈ $249/26780 ≈ **$0.0093/个**
- Hailuo-02 768P 6s ≈ $249/26780 ≈ **$0.0093/个**
- Hailuo-02 512P 6s ≈ $249/26780 ≈ **$0.0039/个**

> 对比：按需付费（PAYG）价格更高，套餐适合月均10+视频生成的用户

---

## 四、API调用方式详解

### 4.1 异步调用三步流程

来源：`https://www.minimaxi.com/news/%E8%A7%86%E9%A2%91%E7%94%9F%E6%88%90api%E6%AD%A3%E5%BC%8F%E5%8F%91%E5%B8%83`

**Step 1：提交任务**

```bash
POST https://api.minimax.io/v1/video_generation
Authorization: Bearer <API_KEY>

{
  "model": "MiniMax-Hailuo-02",
  "prompt": "中文描述",
  "resolution": "1080p",
  "duration": 6
}
```

**响应：**
```json
{"task_id": "xxxxxxxx"}
```

**Step 2：轮询状态**

```bash
GET https://api.minimax.io/v1/query/video_generation?task_id=xxxxxxxx
```

**Step 3：下载结果**

- 返回的file_id通过File API下载
- ⚠️ **URL有效期：9小时（32400秒）**，过期后文件丢失

### 4.2 Endpoint

| 版本 | URL |
|------|-----|
| 全球版 | `https://api.minimax.io/v1/video_generation` |
| 中国大陆版 | `https://api.minimaxi.com/v1/video_generation` |

### 4.3 RPM限制

- Starter：20 RPM
- Standard：30 RPM
- Professional：40 RPM
- Enterprise：50 RPM
- Unlimited：不限

超过RPM后触发限流，需等待或升级套餐

---

## 五、典型用例（写作IDE场景）

### V0阶段：暂不接入
- 理由：视频生成API为异步调用，需轮询，不适合IDE同步交互流
- V0阶段建议：仅在用户主动触发时使用Hailuo AI网页端手动生成

### V1阶段（计划接入）

| 场景 | 推荐模型 | 理由 |
|------|---------|------|
| 文章配套短视频 | Hailuo-02 | 1080P质量，6-10s适合短视频 |
| IP角色动画 | Hailuo-02（图生视频） | 保持角色一致性 |
| 快速预览 | Hailuo-2.3-Fast | 消耗点数少，速度快 |

---

## 六、与其他视频生成API对比

| 维度 | MiniMax Hailuo | Runway Gen-4.5 | Pika 2.0 | Sora |
|------|---------------|---------------|---------|------|
| API接入 | ✅ 官方API | △ 有限 | ✅ API | △ 有限 |
| 1080P | ✅ Hailuo-02原生 | ✅ | ❌ | ✅ |
| 中文Prompt | ✅ 优化 | △ 一般 | △ | △ |
| 时长 | 6-10s | 5-10s | 3-10s | 最高20s |
| 价格（参考） | ~$0.01/个 | 订阅制 | 订阅制 | 内测 |
| 指令遵循 | SOTA级 | 强 | 中 | 强 |

---

## 七、优劣势总结

### 优势
- ✅ **物理表现突出**：肢体动作、面部表情真实性高
- ✅ **指令遵循能力强**：prompt还原度好
- ✅ **图生视频**：锁定角色一致性，适合IP运营
- ✅ **API异步设计合理**：支持大规模批处理
- ✅ **Hailuo-02原生1080P**：区别于竞品upscaled方案

### 劣势
- ❌ **V0暂不接入**（任务要求明确）
- ❌ **生成需等待**：异步，URL有效期仅9小时
- ❌ **RPM限制**：需按套餐限制并发
- ❌ **极长镜头控制有限**：复杂运镜/镜头语言不如电影级工具
- ❌ **Hailuo 3涨价预期**：2026年6月发布后可能涨价
