# DeepSeek V4 Flash —— 模型认知与使用技巧

本项目唯一调用的上游模型。本文档汇总官方文档的能力 / 参数 / 计费认知，**并落到本项目的实际用法**（`app/services/deepseek.py`、`app/core/prompt.py`、`app/services/pricing.py`、`app/services/translator.py`）。调模型、改请求体、动费率前先读此文。

> 数据来源：DeepSeek 官方 API 文档（api-docs.deepseek.com，2026-04-24 V4 发布）+ 本项目 2026-06-05 关思考对照实测。价格随官方调整，以官方页为准。

---

## 1. 是什么

`deepseek-v4-flash` 是 DeepSeek V4 系列里**效率优先**的变体，与旗舰 `deepseek-v4-pro` 同代。

| | V4 Flash | V4 Pro |
|---|---|---|
| 总参数 / 激活参数（MoE） | 284B / 13B | 1.6T / 49B |
| 上下文窗口 | 1M tokens（1,048,576） | 1M tokens |
| 最大输出 | 384K tokens | 384K tokens |
| 思考模式 | 支持，**默认开** | 支持，默认开 |
| 定位 | 推理能力接近 Pro、简单 agent 任务相当，**更快更便宜** | 世界知识 / 数学 / STEM / 代码 / agentic 顶级 |

- 架构亮点：MoE + 新注意力机制 **Token-wise compression + DSA（DeepSeek Sparse Attention）**，是 1M 上下文下保持效率的关键。
- 能力面：thinking / non-thinking 双模、JSON Output、Tool Calls、Chat Prefix Completion（beta）、FIM 补全（**仅 non-thinking 模式**）。
- 本项目选 Flash 而非 Pro：网页翻译是「理解 → 改写」任务，不吃顶级推理；Flash 的速度与价格更适合**逐块流式、整页全翻**的场景。

---

## 2. 价格与计费

官方按 token 计价（美元 / 每 1M tokens）：

| 模型 | cache-hit 输入 | cache-miss 输入 | 输出 |
|---|---|---|---|
| **deepseek-v4-flash** | **$0.0028** | **$0.14** | **$0.28** |
| deepseek-v4-pro | $0.003625 | $0.435 | $0.87 |

- **cache-hit 输入是 cache-miss 的 1/50**（$0.0028 vs $0.14）——这是「稳定前缀命中缓存」值得追求的直接经济动因，见 §4。
- 人民币换算 ≈ 输入 **¥1/M**、输出 **¥2/M**（按 ~7.14 汇率，与美元三档自洽）。
- **本项目按桶币种透传两套官方定价、×2 服务费扣 credits**（`pricing.py`）：人民币桶用 `cost_cny`（¥ 三档：miss 0.000001 / hit 0.00000002 / out 0.000002 元每 token），美元桶用 `cost_usd`（$ 三档：miss 0.00000014 / hit 0.0000000028 / out 0.00000028 美元每 token）。**多币种分桶扣费规则见 [`CLAUDE.md`](CLAUDE.md) 额度模型**——美元充值（Creem）按美元价扣，人民币（赠送 / 微信充值）按人民币价扣，**不做汇率换算**。已按 `prompt_cache_hit/miss_tokens` 分 cache-hit/miss 三档计价。
- 要调毛利改 `SERVICE_FEE_RATE`（当前 2，即 +100% 服务费）；官方调价时同步 `pricing.py` 的 ¥ / $ 两套常数。

---

## 3. 思考模式（thinking / reasoning）

### 控制参数

请求体**顶层**字段（OpenAI 原生格式直接放；OpenAI SDK 经 `extra_body` 传）：

```json
{ "thinking": { "type": "enabled" } }   // 或 "disabled"
```

- **默认 `enabled`（开思考）**，V4 Flash 与 Pro 均如此。本项目 **显式发 `{"type": "disabled"}` 关掉**（`deepseek.py build_request_body`）。
- 开思考时，思维链（CoT）经 **`reasoning_content`** 字段返回，与 `content` 同级。
- `reasoning_effort`：`high` | `max`（默认 `high`；复杂 agent 请求自动升 `max`；旧值 `low`/`medium`→`high`、`xhigh`→`max`）。本项目关思考，不涉及。
- 多轮：**有 tool call 时必须把上一轮 `reasoning_content` 回传**；无 tool call 可省略历史 CoT。

### 关思考模式下的约束（重要）

> **思考模式下 `temperature` / `top_p` / `presence_penalty` / `frequency_penalty` 全部无效**（设了不报错，但不起作用）。

这正是本项目**关思考的隐藏前提**：我们要 `temperature: 0.2` 来压低翻译随机性、求稳定输出——**只有关掉思考，这个 0.2 才真正生效**。若开着思考，采样参数被忽略，译文确定性无从谈起。

### 为什么本项目关思考

- 翻译不需要长链推理；关思考后**首 token 更快、不产生 reasoning_tokens**（省输出费）、输出更确定。
- **2026-06-05 对照实测坐实**：不发 thinking 字段时上游返回 107 字符推理内容，发 `{"type":"disabled"}` 时为 0——确认「默认开思考、显式 disabled 能真正关掉」。
- 关思考契合扩展端「逐块流式、原文先垫、译文淡入替换」的隐形体验：要的是快和稳，不是模型自言自语。

---

## 4. 前缀缓存（Context Caching / KV Cache）

DeepSeek 对**磁盘上的 KV 缓存**做硬盘级前缀复用，**默认开启、对调用方透明、无需改代码**。

- **命中条件：请求前缀与此前持久化的缓存单元「完全匹配」**（部分匹配不算）。缓存单元在请求边界（user 输入 / model 输出末尾）、跨请求公共前缀、长输入的固定 token 间隔处形成。
- usage 返回两个字段标识命中情况：`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`。
- 自动清理，通常几小时到几天；**无 TTL 保证、best-effort、不保证 100% 命中**。

### 本项目如何利用

铁律「**系统提示词逐字节稳定**」（`prompt.py` 的 `SYSTEM_PROMPT` 是唯一来源、禁止动态拼接）就是为命中前缀缓存服务的：

- system 消息内容固定 → 它构成所有翻译请求的**公共前缀** → 第二次起 system 段走 cache-hit（1/50 价）。
- 任何把动态内容（块、编号、白名单）拼进系统提示词的改动，都会**让前缀缓存失效**，并连带令 `hashing.py` 的版本键（`sha256(MODEL + " " + SYSTEM_PROMPT)`）翻转。改 `SYSTEM_PROMPT` 一个字符即有此后果，务必慎重。

---

## 5. 流式与真实用量

- 本项目走 `stream: true`，逐 token 消费 `choices[0].delta.content`（`deepseek.py stream_content_deltas`）。
- 请求带 `stream_options: {include_usage: true}`，**末尾事件携带真实 `usage`**（`prompt_tokens` / `completion_tokens`）。记账以它为准、缺失时用 `tokens.py estimate_tokens` 本地估算兜底（`translator.py`）。
- `max_tokens: 384000`（`deepseek.MAX_OUTPUT_TOKENS`）= 输出上限，与官方 384K 对齐，配合 `OUTPUT_TOKEN_BUDGET` 装箱防截断。
  ⚠️ 注意 1M 是 **input+output 总预算**，384K 仅是 output 上限；超长全文需同时盯输入侧总量。

---

## 6. API 迁移与兼容

- **base_url 不变**，只把 `model` 改成 `deepseek-v4-flash` / `deepseek-v4-pro` 即可。兼容 OpenAI ChatCompletions 与 Anthropic API 两套格式。
- 旧模型名 **`deepseek-chat`（映射 non-thinking）/ `deepseek-reasoner`（映射 thinking）将于 2026-07-24 15:59 UTC 弃用**，届时不可访问；现阶段它们路由到 V4 Flash 变体。本项目已直接用新名 `deepseek-v4-flash`（`hashing.py` 的 `MODEL`），不受弃用影响。

---

## 7. 本项目实际请求体（速查）

`app/services/deepseek.py build_request_body` 发出的体：

```json
{
  "model": "deepseek-v4-flash",
  "stream": true,
  "stream_options": { "include_usage": true },
  "thinking": { "type": "disabled" },
  "temperature": 0.2,
  "max_tokens": 384000,
  "messages": [
    { "role": "system", "content": "<逐字节稳定的 SYSTEM_PROMPT>" },
    { "role": "user",   "content": "[[id]] 原文\n[[id]] 原文 ..." }
  ]
}
```

每个设计点的依据：`thinking.disabled` → 让 `temperature` 生效 + 省时省钱（§3）；稳定 system → 命中前缀缓存（§4）；`include_usage` → 真实记账（§5）；`max_tokens 384000` → 对齐输出上限（§5）；`temperature 0.2` → 压随机、求稳定译文。

httpx 客户端用 `trust_env=False` 直连 `api.deepseek.com`（中国服务无需代理，绕开开发机个人 SOCKS 代理）。

---

## 8. 注意事项 / 待校准

- **价格会变**：上表为发布期数据；`pricing.py` 是成本价透传，官方调价时同步常数。
- **temperature 只在关思考下有效**——任何「想让译文更稳 / 更活」的调参，前提是 `thinking.disabled` 仍在。
- **1M 总预算 vs 384K 输出上限**是两回事，超长页面要分别核对。
- 默认开思考这点上线后若官方调整默认值，需复测（曾有第三方文档误称 Flash 默认关，以官方文档 + 本项目实测为准）。
- 前缀缓存 best-effort、无 TTL 保证：命中率波动属正常，不应据单次 usage 的 cache 字段下强结论。

---

## 9. 速率限制 / 并发 / 多 key（2026-06-16 查证 + 决策）

> 来源：DeepSeek 官方 rate limit 文档（api-docs.deepseek.com）+ 本项目讨论决策。

**DeepSeek 的限制是「并发数」，不是 RPM/TPM**：
- v4-flash **2,500 并发** / v4-pro 500 并发（一个请求从发出到响应完成＝占一个并发）。超限返 **429**，**可免费申请扩容**。
- **并发按「账号」计算，与用哪个 API key 无关**——同账号的多个 key **共享**同一配额。
- 没有「每分钟请求数 / token 数」（RPM/TPM）限制。

**「多 key」的真相（易误解）**：
- 同账号多 key **不能**扩并发、**不能**做账号级 failover（欠费 / 封号是账号级，同账号一起挂）。
- 多 key 只用于**密钥管理**：泄露时单独吊销受损 key、按 key 分用量统计、平滑轮换。

**决策：上游 key 池暂缓**（原后端完善计划的 ③）。理由：
- 单账号 2,500 并发对 flash 极高，现阶段（`translator.CONCURRENCY=4` + 少量用户）远撞不到，且能免费扩容——并发墙不是当前问题。
- 单账号 + key 在 `server/.env`、已靠「绝不下发客户端 / 不入日志」控泄露，多 key 的管理价值也弱。
- **要真正扩并发 / 容灾，必须「多账号」（N×2500 + 各自独立余额 + 账号级 failover）或「跨 provider（字节火山）」。** 多账号池轮换仍待做（届时接入 admin 已有 CRUD 的 `upstream_keys` 表，`translate.py` 现写死 `settings.deepseek_api_key` 单 key）。

**✅ 跨 provider failover 已实现**（2026-06-17，`deepseek.py` `Provider` + `stream_with_failover`）：官方 DeepSeek 主线，配齐 `volcengine_api_key`+`volcengine_model`（火山方舟 Ark，OpenAI 兼容端点 `volcengine_base_url`）才启用备线。**仅首 token 前失败才切源**，已吐内容再失败不换源（避免半句重来）。火山方舟 V4 Flash 命中价 ¥0.20/M（官方 ¥0.02 的 10×），且 `thinking:disabled` 顶层参数在 Ark 是否照收**未真机联调**——真接火山时校准。火山是罕见兜底，计费暂仍按官方三档价。

---

## 参考来源

- DeepSeek API 官方文档：定价、思考模式、上下文缓存、V4 发布说明（api-docs.deepseek.com）。
- 本项目代码：`app/services/deepseek.py`、`app/core/prompt.py`、`app/core/hashing.py`、`app/services/pricing.py`、`app/services/translator.py`、`app/core/tokens.py`。
- 本项目实测：2026-06-05 关思考对照（见 memory `deepseek-v4-flash-is-reasoning-model`）。
