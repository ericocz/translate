# 第二批 · BYOK（自带模型）实施方案

> **文件性质**:一次性**施工蓝图**,供后续直接编码参照。落地后架构决策回写 [`front/CLAUDE.md`](CLAUDE.md) / [`server/CLAUDE.md`](../server/CLAUDE.md),本文件即可删(遵循仓库文档纪律:长期权威在 CLAUDE.md,不留分散设计文档)。
>
> 上游已定决策见 memory `paid-model-no-free-tier-byok-multimodel`;后端翻译管线认知见 [`server/deepseek-v4-flash.md`](../server/deepseek-v4-flash.md)。

---

## 1. 目标与边界

**做什么**:买断用户可在扩展里配置「自己的模型 + key/endpoint」(含本地模型),翻译时由 **service worker 直连该 provider**,不经我们后端、不消耗平台额度。

**不做什么**:
- 不碰平台模式(路径 ②,走后端 `/v1/translate`)的现有逻辑。
- 不为每个模型 fork 提示词(只按目标语言 fork);不为弱模型做重度定制(中档策略兜底)。
- 收单激活的支付商接入按「最小可用」做(见 §7),大改留后。

**前置**:第一批(额度地基)已合并 —— 买断态与额度账户互不耦合,可独立推进。

---

## 2. 已定决策速查

| 项 | 决策 |
|---|---|
| 买断 | $9.99 一次性 = **解锁 BYOK**,不送平台额度、不注册(绑设备,`instanceID`+`storage.local`+服务端指纹) |
| 翻译路径 | BYOK = **SW 客户端直连**用户 provider,不经后端、不计费、平台零成本;支持本地模型 |
| 占位符 | **格式不改**(`<gN>`/`<xN>`/`[[id]]`) |
| 质量 | **中档**:提示词强化+few-shot、markers/切块容错、兼容性自检、推荐清单、降级率反馈、现有校验降级兜底 |
| key | 存 `chrome.storage.local`,**永不上传**;可选本地 PIN 加密;本地模型可无 key |
| 提示词 | 按**目标语言** fork(非模型);协议层(标记+`[[id]]`)所有模型焊死一致 |
| 上下文 | per-provider 的 `batchBudget`/`concurrency`;小模型算输入侧;本地并发降级 |

---

## 3. 端到端架构

```
content(extractor 生成 <gN>+styleMap，styleMap 只在 content)
   │  带 <gN> 标记的 source 块
   ▼
service worker ── 查本地 IndexedDB 缓存 ─ 命中 → 回填
   │ 未命中
   ├─ 平台模式  → api.ts → 后端 /v1/translate（现状，扣 credits）
   └─ BYOK 模式 → local-engine/local-translator → 直连用户 provider（新增，不计费）
   │  译文块（带 <gN>）
   ▼
content ← markers.ts 校验 → rebuilder.ts 用 styleMap 重建 → 淡入
```

**关键对等**:BYOK 下 SW 接管「后端的角色」,与后端一样**只处理带标记文本、不碰 styleMap**。复用 content 侧的 `extractor`/`markers`/`rebuilder` 不变;新增的是 SW 里一套「本地翻译引擎」,镜像后端 `services/` 但用 TS。

**与现有的关系**:`local-translator` 与现有 `translate-cached.ts`(调后端)平级,由模式开关二选一。本地缓存层(`local-cache.ts`)对两条路径**都生效**(BYOK 译文也写回本地缓存)。

---

## 4. 核心抽象:`ProviderConfig`

两个难题(提示词适配、上下文差异)都收敛到这一个配置,**加新模型 = 加一行配置,不改代码**。

```ts
// lib/local-engine/types.ts
interface ProviderConfig {
  id: string;            // 'deepseek' | 'openai' | 'claude' | 'ollama' | 'custom'
  label: string;         // UI 显示名
  endpoint: string;      // chat/completions（或 anthropic messages）URL
  apiKey: string;        // 存 storage.local，本地模型可空
  model: string;         // model id
  format: 'openai' | 'anthropic';  // 唯二两套适配器
  contextWindow: number; // 上下文 token
  maxOutput: number;     // 输出上限 token
  batchBudget: number;   // 装箱输出预算（喂 batchByTokenBudget；可由 ctx/out 推导或手填）
  concurrency: number;   // 并发批数（本地调 1~2）
  promptLang: string;    // 'zh' | 'ja' | 'en' …选哪版提示词
  extraBody?: Record<string, unknown>; // provider 专有字段，merge 进请求体
}
```

**`extraBody` 是关键**:把所有 provider 专有差异收敛到一字段,通用适配器 merge,不为每家写死代码:
- `deepseek` → `extraBody: { thinking: { type: "disabled" } }`(**关思考靠这个字段、与 key 无关**;不发则默认开思考 → `temperature` 失效、变慢变贵)
- OpenAI o 系列 → `{ reasoning_effort: "low" }`
- 普通/本地模型 → 省略

**预设表**(`lib/local-engine/presets.ts`,用户可覆盖):

| id | format | endpoint | ctx | maxOut | budget | conc | extraBody |
|---|---|---|---|---|---|---|---|
| deepseek | openai | api.deepseek.com/v1/chat/completions | 1M | 384K | 384000 | 4 | `{thinking:{type:disabled}}` |
| openai | openai | api.openai.com/v1/chat/completions | 128K | 16K | 12000 | 4 | — |
| claude | anthropic | api.anthropic.com/v1/messages | 200K | 8K | 6000 | 4 | — |
| ollama(本地) | openai | http://localhost:11434/v1/chat/completions | 8K | 4K | 3000 | 1 | — |
| custom | openai | 用户填 | 用户填 | 用户填 | 推导 | 2 | 用户填 |

> `batchBudget` 缺省推导:`min(maxOutput, (contextWindow − systemPromptTokens − 余量) / 2)`。

---

## 5. 前端模块:`lib/local-engine/`

镜像后端 `services/`,全 TS、跑在 SW。逐文件:

### 5.1 `prompt.ts` —— 提示词(按语言 fork)
- 源:`server/app/core/prompt.py` 的 `SYSTEM_PROMPT`。
- 设计成 `PROMPTS: Record<Lang, string>`,每语言一个**逐字节稳定常量**(对齐前缀缓存思路;BYOK 自己账号也命中)。
- **第二批先落 `zh` 版(与后端现有逐字一致)**;多语言是后续扩展(平台后端也要同步 fork,跨批)。
- **协议段焊死**:`<gN>` 保留规则 + `[[id]] 译文` 输出格式,所有语言版共用同一段文字。
- 弱模型强化:在协议段后可附 1~2 个 **few-shot 示例**(输入带标记 → 正确输出),作为常量的一部分。

### 5.2 `estimate-tokens.ts` —— token 估算
- 直接照搬 `server/app/core/tokens.py`:CJK `[㐀-鿿…]` 按 0.6/字,其余按 /4,`Math.ceil`。
- 用于 `batchByTokenBudget` 装箱。

### 5.3 `block-splitter.ts` —— `[[id]]` 流式切块
- 照搬 `server/app/services/block_splitter.py` 的 `BlockSplitter`(`feed`/`flush`,累积缓冲重扫)。
- 正则 **id 字符类必须含 `.`**:`/\[\[([A-Za-z0-9_.\-]+)\]\]/g`(SPA 块 `r2.b30`)。
- **容错增强**(中档):喂入前对缓冲做轻规范化,救回常见模型偏差 —— `[ [`/`] ]` 夹空格、全角 `［［` 等 → 归一成 `[[`/`]]` 再切。

### 5.4 `providers.ts` —— provider 适配(唯二两套)
统一接口:
```ts
interface ProviderAdapter {
  buildBody(cfg, systemPrompt, userBlocks): object;   // 含 stream + extraBody merge
  parseSSELine(line): { delta?: string; usage?: Usage } | null;
}
```
- **openai 适配器**:body = `{model, stream:true, stream_options:{include_usage:true}, temperature:0.2, max_tokens:cfg.maxOutput, messages:[{system},{user}], ...cfg.extraBody}`;SSE 取 `choices[0].delta.content`、末帧 `usage`(对齐后端 `deepseek.py`)。覆盖 DeepSeek/OpenAI/Kimi/GLM/Ollama。
- **anthropic 适配器**:body = `{model, stream:true, system:<顶层>, messages:[{user}], max_tokens, ...extraBody}`;SSE 解析 `content_block_delta` 的 `delta.text`、`message_delta` 的 usage。
- fetch 在 SW 发(host_permission 覆盖),`ReadableStream` reader 逐行喂 `parseSSELine`。
- 错误分类对齐后端:401/403→auth、4xx/5xx→api、网络层→network(本地模型连不上归 network,提示"本地服务未启动?")。

### 5.5 `local-translator.ts` —— 编排(对应 `translator.py`)
- 入参:`blocks: SourceBlock[]`、`cfg: ProviderConfig`、`onEvent`(block/usage/done/error)。
- 流程照搬后端 `translate()`:
  1. **按 source 去重**(代表块发模型,译文广播给同 source 的 id)。
  2. **`batchByTokenBudget(blocks, cfg.batchBudget)`** 装箱。
  3. **有限并发** `cfg.concurrency`(前端用 Promise 池/信号量;**本地模型 conc=1**)。
  4. 每批 fetch provider 流 → `BlockSplitter` 切块 → `markers.ts` 校验 → 逐块回 `BlockEvent`。
  5. **失败隔离**:单批挂不打断其余;全挂才 `ErrorEvent`;校验不过的块仍回送(content 再判 → 降级保原文)。
- 不做记账/扣费(BYOK 不计费);可统计 success/total 供**降级率反馈**(§7)。

### 5.6 复用(不在 local-engine,已有)
- `markers.ts`(校验)、`rebuilder.ts`(重建)、`extractor.ts`(抽块+标记)、`local-cache.ts`(本地缓存)、`device.ts`(deviceId/instanceID)。

---

## 6. 买断态与激活

### 前端
- `storage.local` 存:`buyout: { active: boolean; code?: string; activatedAt? }` + `byokConfig: ProviderConfig | null` + `byokEnabled: boolean`。
- 翻译入口判定:`buyout.active && byokEnabled && byokConfig` → 走 BYOK;否则平台模式。
- `device.ts` 提供持久标识:`chrome.instanceID.getID()` + `storage.local` 标识(双保险;清缓存/升级不丢,卸载重装才变)。

### 后端(server,第二批补)
现成:`redeem_codes` 表 + `redeem_repo.issue()`(creem webhook 已签发,见 `billing.py`)。**要补**:
1. **激活/验证端点** `POST /v1/redeem/verify` `{code, deviceId}`:校验 code `active` + 绑定设备数 < `max_devices`(=5) → 记一条绑定 → 返回 `{ok, product}`;超额/无效 → `{ok:false, reason}`。
2. **`redeem_activations` 表**(新):`code_id, device_id, activated_at`,唯一 `(code_id, device_id)`(同设备重复激活幂等)。
3. Stripe 收单:沿用/迁移(见 §7 待拍板)。

---

## 7. 质量保障落地(中档五件套)

1. **提示词强化 + few-shot**:`prompt.ts` 协议段写死「原样保留 `[[id]]`/`<gN>`、绝不翻译或改编号」+ 附正反例常量。
2. **容错解析**:`block-splitter`(§5.3)+ `markers` 救回大小写/空格/全角/自闭合变体 —— 在校验**前**做归一化,而非直接拒绝。
3. **兼容性自检**:配好 provider 后,options 页「测试」按钮发一个**含已知占位符的固定测试块** → 跑完整 local-translator → 算标记保留率 → 评分「好/中/差」。差则警示+荐换。
4. **降级率反馈**:翻译时统计 `success/total`;某次降级率高(如 >30%)→ popup 柔提示「当前模型对占位符支持不佳,建议换 X」。
5. **推荐清单**:预设表里标注「已验证」provider;custom 给风险提示。

---

## 8. UI

### options(BYOK 配置区,买断后才显)
- 开关 `byokEnabled`。
- provider 选择:预设下拉 + custom;字段 endpoint/apiKey/model/format/ctx/maxOut(custom 手填,预设自动填)。
- 「测试兼容性」按钮(§7.3)。
- key 安全说明 +(可选)本地 PIN 加密开关。

### popup
- 买断入口(未买断:CTA → 购买;已买断:显「BYOK · 模型名」当前态)。
- **买断码激活**:输入框 → `POST /v1/redeem/verify` → 成功写 `buyout.active`。
- 模式角标:当前是「平台额度」还是「自带模型」。

---

## 9. manifest / 权限
- `optional_host_permissions`:**运行时**按用户填的 endpoint host 申请(含 `http://localhost/*`),**不预申请 `<all_urls>`**(商店审核友好)。
- 配置 provider 时 `chrome.permissions.request({ origins: [endpointOrigin] })`。

---

## 10. 双端一致性(防漂移)
`prompt` / `block-splitter` / `estimate-tokens` + 标记协议变成「Python 一份、TS 一份」。改翻译协议必须两端同步。
- **金标向量**(像 D-13 加密):一组共享 fixture(输入 → 期望切块/校验结果),`server/tests` 与 `front` 各跑一遍,值对齐。
- 放 `front/test-vectors/`(或仓库根),两端读同一 JSON。

---

## 11. 编码步骤(建议顺序)
1. `types.ts` + `presets.ts`(ProviderConfig + 预设表)。
2. `estimate-tokens.ts` / `block-splitter.ts`(搬运 + 容错)+ 金标向量双端对齐。
3. `prompt.ts`(zh 版,协议段对齐后端 + few-shot)。
4. `providers.ts`(openai 适配器先行,覆盖 DeepSeek/本地;anthropic 后加)。
5. `local-translator.ts`(编排;接 markers 校验 + 降级统计)。
6. SW 路径分流:`byokEnabled` 时走 local-translator,写回 `local-cache`。
7. options/popup UI(配置 + 测试 + 激活)。
8. 后端:`redeem_activations` 表 + `POST /v1/redeem/verify`。
9. 兼容性自检 + 降级率反馈接线。
10. manifest optional_host_permissions + 运行时申请。
11. 回写 `front`/`server` CLAUDE.md,删本方案文件。

---

## 12. 待你拍板的点
- **A. 支付商**:买断收单用 **Stripe**(记忆里定的「去 Creem 改 Stripe」)还是先沿用现成 `creem.py`?影响 §6 后端。
- **B. 多语言提示词**:第二批 BYOK **只做 zh** 版(最快落地)、多语言留后(且要平台后端同步 fork)?还是这批一起把语言 fork 做了?
- **C. anthropic 适配器**:第二批就做(覆盖 Claude),还是先只 openai 兼容(DeepSeek/OpenAI/Kimi/GLM/本地全覆盖)、Claude 下批?
- **D. 兼容性自检**:评分「差」时**仅警示**(不拦)还是**软拦**(劝退才让用)?
- **E. 本地 PIN 加密 key**:第二批做还是留后(默认仅 storage.local 不上传已是主要防线)?
