# server/CLAUDE.md —— FastAPI 后端

「秒懂翻译 / aha translate」的后端，拥有「翻译这件事」的全部业务。仓库总览见 [`../CLAUDE.md`](../CLAUDE.md)。

**为什么服务端化**：原本是纯客户端自用——DeepSeek Key 随构建注入、提示词 / 流水线全在扩展内。要公开上架就有硬伤：① Key 解包即被盗用；② 没账号 / 额度 / 记账 / 打点，挡不住刷量也看不到线上。故把「翻译流水线 + 密钥 + 账号 + 额度 + 记账 + 收单」整体收进后端，扩展退化为「DOM 端 + API 客户端」。译文**不在服务端留存**（隐私）——缓存改到客户端本地，命中不发服务端、不计费。

## 技术栈

- Python **3.12**（uv 锁定；机器默认 3.14 生态兼容差，用 `uv venv --python 3.12`）。
- FastAPI（async）+ SQLAlchemy 2.0 async + asyncpg + Alembic 迁移；PyJWT + argon2-cffi；pytest + pytest-asyncio。
- SSE 用 `StreamingResponse` 手写 `event:` / `data:` 帧。
- **uv 直连官方 PyPI**（作者有 VPN、服务器部署在香港；原清华镜像 `[[tool.uv.index]]` 已撤）。

## 模型：DeepSeek V4 Flash

调用 `deepseek-v4-flash`（`app/core/hashing.py` 的 `MODEL`），关思考、稳定前缀、真实 usage。1M 上下文 / 384K 输出上限。成本价**三档**（每 M token）：人民币 输入·未命中 ¥1 / 命中 ¥0.02 / 输出 ¥2；美元 $0.14 / $0.0028 / $0.28（DeepSeek 官网英文定价）——`deepseek.py` 从 usage 的 `prompt_cache_hit/miss_tokens` 拆出命中/未命中。**走平台 key 的翻译按三档成本价 ×2（+100% 服务费）扣 credits**，按扣费桶币种选 `pricing.py` 的 `cost_cny` / `cost_usd`（+ `SERVICE_FEE_RATE`，平台唯一持续盈利来源，**两套官方定价各自透传、不换汇**）。**模型能力、参数、前缀缓存、关思考的完整认知见 [`deepseek-v4-flash.md`](deepseek-v4-flash.md)**——调模型 / 改 `deepseek.py` / 动费率前先读它。

## 铁律（模型侧，逐条对应客户端旧约束）

1. **系统提示词按目标语言各自逐字节稳定**（`app/core/prompt.py` 唯一来源；禁止把**随请求变化**的内容——块/编号/白名单——拼入）——同一目标语言前缀完全一致 → 命中 DeepSeek 前缀缓存（cache-hit 价仅 miss 的 1/50）。**目标语言可选**（前端 popup 选、随 body `target` 下发）：`system_prompt(target)` 中 `target=='zh'`/缺省返回历史**简体中文** prompt（逐字节不变、守既有前缀缓存与调优），其余目标语言走通用英文模板 `_GENERIC_PROMPT`（`{{LANG}}` 注入目标语言英文名，名单 `lang_names.json` 由 `front/lib/languages-*.json` 生成）。低基数 + 按语言稳定 = 每种语言独享自己的前缀缓存（不违反铁律）。⚠️ 繁体 `zh-TW`/`zh-HK` 走通用模板（语言名含 Traditional）→ 输出繁体；只有精确 `zh` 复用简体专用 prompt。
2. **显式关思考**：请求体顶层 `thinking: {type: "disabled"}`（V4 Flash 默认开思考；关掉后首 token 快、不产 reasoning_tokens，且 `temperature` 才生效——思考模式下采样参数无效）。
3. **按 token 预算装箱 + 有限并发**（`batch_by_token_budget`：累计 `estimate_tokens(src)` ≤ `OUTPUT_TOKEN_BUDGET=1500`，整页切多箱、`CONCURRENCY=4` 并发跑）；**按 source 去重**。**为什么不再「全文单请求」（原 D-12 已反转）**：巨请求 = 巨 prompt 预填 + 整页输出串行生成 → 首屏干等数秒、墙钟≈全页 token 顺序出；切成 ~1500 小批并发后，**首批（页面顶部）秒级回**（体感「秒懂」）、墙钟≈全页÷并发、且短生成更不易漏块/截断。软上限 `OUTPUT_TOKEN_BUDGET` << 截断硬顶 `deepseek.MAX_OUTPUT_TOKENS=384000`（后者仅防爆）。成本几乎不变（重发的系统提示词走前缀缓存命中价 1/50、原文每块仍只发一次、输出总量不变）；小页（总估算 < 1500）仍只装一箱。
4. **`[[id]]` 流式切块 + 即时回送**：模型逐 token 返回、标记常被拆散——在**完整缓冲**上重扫（`block_splitter.py`）；正则字符类**必须含 `.`**（沉降补抽 / SPA 用 `r{batch}.b{n}`）。**切出一块必须即刻 `queue.put_nowait` 回送（`translator.py` 的 `on_block`），绝不能「append 进 list、整批流完再统一入队」**——后者会让整批译文在批末一次性涌出（实测回归：12 块全挤在末尾 2ms 内到达，体感「一下子全部翻译完」）。正确做法下首块约 2.4s 即达、之后逐块到（守卫见 `test_blocks_stream_incrementally_not_buffered`）。
5. **标记平衡校验**（`markers.py`，与客户端等价）——决定 `success` 计数与「全失败才报错」；校验不过的块仍原样回送、由客户端再校验。
6. **真实 usage**：请求带 `stream_options.include_usage`，取末块 `usage` 计 Token、缺失时 `estimate_tokens` 兜底；**只对服务端实际翻译的块记账**（命中本地缓存的块根本不到服务端）。
7. **API Key 只在服务端 env**（`app/core/config.py`，绝不下发客户端、绝不入日志 / 事件）。翻译统一走平台 key、统一计费（取消买断 / BYOK 后无客户端直连路径）。
8. **DeepSeek 直连**：httpx `trust_env=False`（DeepSeek 是中国服务无需代理，绕开开发机个人 SOCKS 代理、省 socksio 依赖）。
9. **跨 provider failover**（`stream_with_failover`）：官方 DeepSeek 主线，**配齐 `volcengine_api_key`+`volcengine_model` 才**启用火山方舟（Ark，OpenAI 兼容）备线。**仅在首 token 前失败才切源**（连接/非200/早期异常）；已吐内容再失败不换源（避免半句重来，交单批失败隔离 + 漏块下次重试）。同账号多 key 不解决容灾（账号级一起挂），故必须跨 provider。火山是罕见兜底、暂仍按官方价计费。**已真机联调验证（2026-06-18）**：火山 model `deepseek-v4-flash-260425`、默认 `volcengine_base_url` 的 OpenAI 兼容端点，接受同一顶层 `thinking:{type:disabled}` 参数、标记格式无损、failover 切换端到端成立。⚠️ 火山 usage **不返回 `prompt_cache_hit_tokens`**（恒 `input_hit_tokens=0`）→ failover 期间整批按未命中价（¥1/M）计、且按官方价 ×2 记账 → 用户该次偏贵（知情接受，failover 罕见）。
10. **应用层加密（可选）**：见 `X-Eph-Pub` 头则 ECDH(P-256)+HKDF 派生会话密钥（`app/core/crypto.py`，私钥在 env），解密 `ct` 原文 / 加密 `ct` 译文，及解密 auth 的 email/password。**只加密叶子字段**，SSE 信封与标记校验仍在明文上做；**非 E2E**（解密后才发模型）。无头＝明文路径（dev / 测试）。

## 额度模型（商业化底座 · 多币种分桶）

**无匿名 / 免费配额**——装好扩展初始**零额度**，必须先有额度才能翻。额度账户以 `owner` 字符串为键（`credit_repo.py`：`user_owner(id)="u:{id}"`、`device_owner(did)="d:{did}"`），登录用户与未注册设备共用同一套账本。

**多币种分桶（bucket，2026-06-19 取消买断后定）**：`credit_txns` 每行带 `bucket` ∈ `gift_cny`（赠送·人民币）/ `recharge_cny`（充值·人民币）/ `recharge_usd`（充值·美元）；**某桶余额＝该 owner+bucket 的 delta 之和**。人民币桶 delta 单位元、美元桶单位美元。三种来源：

- **赠送 ¥2 → `gift_cny`**：`POST /v1/grant/gift` 幂等发（一设备一次），不需注册。**防薅**：幂等键优先 `gift:inst:{instanceID}`（前端 `chrome.instanceID`——清 storage 免疫、须卸载重装才变），故「清缓存换 deviceId 反复领」被同一 instanceID 拦下；缺 X-Instance-Id 才回退 `gift:d:{deviceId}`。额度发到 device owner。
- **大陆充值 → `recharge_cny`**：须注册（余额跨设备 / 找回）。**YunGouOS 微信扫码**（`POST /v1/recharge/create` 选固定档位 ¥1/5/10/50 下单 → 付款二维码 → 支付后 `notify` 回调验签幂等 grant），**¥1 = ¥1 额度 1:1 入账**（平台盈利在翻译 ×2、不在充值加价）。订单号 `rc-{user_id}-{nonce}` 编码 user_id（落在验签字段 outTradeNo 内 → 可信关联账户）。
- **海外充值 → `recharge_usd`**：须注册。**Creem $9.9 充值美元额度**（唯一档位）。前端用 Creem **静态 payment link** 跳转支付，后端只收 `POST /v1/billing/creem/webhook`：验签 → `checkout.completed` → **凭付款邮箱匹配注册用户** → 幂等 grant 美元桶（`creem:{order_id}`）。**须用注册邮箱付款**，邮箱不符则落 warning、不自动到账（客服可 admin 手动补）。

**扣费优先级 + 按桶币种计价（不做汇率换算）**：每次翻译开始时 `active_bucket(owner)` 取**优先级最高且 >0** 的桶（`gift_cny → recharge_cny → recharge_usd`），整笔 UsageEvent 成本用**该桶币种**三档价计（人民币桶 `cost_cny`、美元桶 `cost_usd`，各 ×2，见 `pricing.py`）扣**该桶**。桶币种各自透传 DeepSeek 官方人民币 / 美元定价——永远只动单一桶、不换汇。本次请求内桶固定一次（避免请求内跨桶分摊）；扣到桶可短暂透支为负，下次翻译该桶 ≤0 即自动切下一个桶。

翻译统一门控（`translate.py`）：owner 任一桶 > 0 才翻、按 active bucket 实耗扣；无账户或三桶全空 → 发 `quota`、不翻。**已删 freemium**（原「匿名每天 3 页」+ 梯度限流连同 `quota.py`/`tier.py`/`anon_usage`/`quota_tier` 全下线）；**已删买断 / BYOK**（2026-06-19：取消买断，Creem 改为充值美元额度；`redeem_codes`/`redeem_activations` 表、`redeem` 端点、`redeem_repo.py` 与前端 `local-engine/` 整套移除）。

## 模块地图

```
app/
  core/    config.py(Settings/env) · prompt.py(SYSTEM_PROMPT 简体专用 + _GENERIC_PROMPT 通用模板 + system_prompt(target)/language_name；lang_names.json=code→英文名) · hashing.py(MODEL + 版本键 sha256)
           tokens.py(轻量 token 估算) · security.py(argon2 + JWT access/admin + refresh 哈希) · crypto.py(ECDH+HKDF+AES-GCM 会话加密)
           ratelimit.py(滑动窗口限流 + **RateLimitMiddleware：纯 ASGI**——非 BaseHTTPMiddleware，后者会把并发长流式响应里的一条 cancel 成 500，区域并发两条 SSE 必中)
  db/      base.py(engine/async_session/Base) · models.py(全部表)
  services/ markers.py · block_splitter.py · deepseek.py(请求体 + SSE + Usage 捕获 + 错误分类 + Provider/stream_with_failover 官方主+火山备)
           translator.py(编排 → 事件流 Block/Done/Error/UsageEvent) · usage_repo.py(daily_usage 统计)
           credit_repo.py(额度账本【方案 B · 多币种分桶】：**某桶余额＝owner+bucket 的 delta 之和**；get_balances 返三桶 dict、active_bucket 取优先级最高且>0 的桶+币种；grant(bucket)/deduct(bucket) 只插流水、has_account=有过流水；user_owner / device_owner) · pricing.py(cost_cny / cost_usd / cost_for(currency)：三档成本价 ×SERVICE_FEE_RATE=2，人民币 / 美元两套官方定价各自透传、**不换汇**，返回**高精度 Decimal、不量化**)
           auth.py · creem.py(Creem webhook HMAC 验签 + checkout.completed 解析 + usd_amount 取实付美元) · email.py(EmailSender 接口 + ResendEmailSender + make_email_sender 工厂：配 resend_api_key+email_from 则真发、否则退化 LogEmailSender) · yungouos.py(大陆充值：微信 nativePay 下单 + 签名/回调验签，签名=字段字典序+key+MD5大写)
  routers/ deps.py(current_user_optional) · translate.py(owner 额度门控 + active bucket 扣费) · usage.py(分桶余额 + 领赠送 /v1/grant/gift) · auth.py · telemetry.py · admin.py · billing.py(Creem 充值 webhook：邮箱匹配 → 美元桶入账) · recharge.py(YunGouOS 充值下单 + notify 回调 grant 人民币桶)
  main.py  挂载全部 router + /health + RateLimitMiddleware
alembic/   迁移
scripts/   create_admin.py(建管理员) · gen_session_keypair.py(生成应用层加密密钥对) · smoke_translate.py(真实链路冒烟)
```

## 数据模型（Postgres）

`users` / `sessions`（账号 + refresh 哈希）· `daily_usage`（每用户每日 token + pages，**登录用户统计用、不再做门控**）· `events` / `error_logs`（打点 / 错误，**只存 host**）· `admins` / `upstream_keys`（管理台）· `credit_txns`（额度流水，**唯一真相**：`owner`＝`u:{id}` | `d:{deviceId}` 索引、`bucket` ∈ `gift_cny`|`recharge_cny`|`recharge_usd`、`delta` **`NUMERIC(18,10)` 高精度**（桶币种原生单位）、`kind`、`idempotency_key` 唯一防重复发放；**某桶余额＝owner+bucket 的 delta 求和**，无 `credit_accounts` 表、不存运行余额，展示层 round 2 位）。**已删表**：`redeem_codes` / `redeem_activations`（取消买断）。

> 译文**不在服务端留存**：原跨用户共享缓存已下线（隐私），缓存改为客户端 IndexedDB 本地层，命中本地的块根本不发服务端、不计费。

## API 表面

- `POST /v1/translate`（**SSE，正文专用**：block / done / error / quota；**owner 任一桶 > 0 才翻、按 active bucket 币种 ×2 扣该桶；无账户或三桶全空发 quota、不翻**；结束发 UsageEvent，登录用户另写 daily_usage；带 `X-Eph-Pub` 头则收发 `ct` 密文；body 可选 `target`＝目标语言代码，缺省 `zh`）
- `POST /v1/translate/batch`（**非流式 HTTP，外框/重试专用**：一次性返 `{blocks:[{id,translated}|{id,ct}], error?, quota?}`。门控/加密/扣费与 SSE 端逐字共用同一份 `_prepare` + `_translate_frames`——只是 SSE 端逐帧序列化、batch 端收集成 JSON。**为什么分两端**：正文走 SSE 求首屏逐块淡入「秒懂」；外框量小、重试是带上下文小整批，都不需要流式体感，非流式少一条长连接、客户端解析更简单）
- `GET /v1/usage`（返三桶余额 `giftCny`/`cny`/`usd`（>0 才展示对应桶）+ `hasAccount` + 登录态；登录另返 `tokensToday`）
- `POST /v1/grant/gift`（发赠送 ¥2（元）；防薅幂等键优先 `X-Instance-Id`（chrome.instanceID）、缺则回退 `X-Device-Id`；缺 deviceId 拒绝）
- `POST /v1/auth/{register,login,refresh,logout}`（register / login 带 `X-Eph-Pub` 头则邮箱 / 密码走 `ct`）
- `POST /v1/recharge/create`（**登录**用户充值下单：选固定档位 → YunGouOS 微信 nativePay → 返付款二维码 + outTradeNo；未登录/未配置/坏档位返 `{ok:false,error}`）
- `POST /v1/recharge/notify`（YunGouOS 异步回调：验签 → 解析 outTradeNo 取 user_id → 幂等 grant 人民币桶 `recharge_cny`；回 `SUCCESS`，验签失败 400 `FAIL`）
- `POST /v1/billing/creem/webhook`（海外充值收单：`creem-signature` HMAC-SHA256 验签 → `checkout.completed` 解析 → **凭付款邮箱匹配注册用户** → 按订单 id 幂等 grant 美元桶 `recharge_usd`（实付 cents/100）；邮箱未匹配回 200 `unmatched`（待客服补）、非充值完成事件回 200 忽略、验签失败回 400）。**发起购买不在后端**：用 Creem **静态 payment link**（前端 options 挂 `WXT_CREEM_RECHARGE_URL` 跳转），后端只收 webhook。
- `POST /v1/events`、`POST /v1/errors`
- `/admin/{login,stats,users,errors,events,keys}`（管理员 JWT `scope:admin`；users 返三桶 `giftCny`/`cny`/`usd`；keys 响应脱敏，绝不回完整 Key）
- `POST /admin/credits/grant`（客服手动调额度：`userId`|`owner` + `amount`（桶币种单位，正补发 / 负退款纠正）+ 可选 `bucket`（默认 `recharge_cny`）+ 可选 `ref`（幂等键 `admin:{ref}` 防误点双发）；复用 `CreditRepo.grant`，kind=`admin_grant`|`refund`；返 `{owner,bucket,amount,balance}`）

## 关键流程

- **翻译**：鉴权识别身份 → 命中客户端本地缓存的块根本不到这里 → **算 owner（登录 `u:{id}`、否则 `d:{deviceId}`）→ 查余额 > 0**（否则发 `quota`、不翻）→ 按 source 去重 → 按 token 预算分批并发调 DeepSeek → 切块 + 标记校验 → `UsageEvent` 时**按 active bucket 币种 `cost_cny`/`cost_usd`（×2）实耗扣该桶**；登录用户另记 `daily_usage`（统计）。
- **额度三来源 / 三桶**：赠送 `gift_cny`（`/v1/grant/gift` 绑设备幂等）/ 大陆充值 `recharge_cny`（YunGouOS，须注册）/ 海外充值 `recharge_usd`（Creem $9.9，须注册）。**无账户 = 零额度 = 不能翻**，前端引导领赠送 / 充值。**扣费优先级** `gift_cny → recharge_cny → recharge_usd`，按桶币种计价、只动单一桶、不换汇（见上「额度模型」）。
- **取消买断 / BYOK（2026-06-19）**：买断这一付费方式与其解锁的 BYOK 客户端直连整套下线——`redeem` 端点 / `redeem_repo.py` / `redeem_codes`·`redeem_activations` 表、前端 `lib/local-engine/` 与 `Byok.tsx` 全部移除；Creem 由「买断收单」改为「美元充值收单」。原跨端金标向量 `test_golden_vectors.py` + `front/test-vectors/` 随 BYOK 撤除（切块 / token 估算服务端仍由 `test_block_splitter.py`/`test_tokens.py` 覆盖）。

## 本地开发环境（重要）

- **dev 库用本机 Postgres.app 的 `imt`(:5432)**，不是 `docker-compose.yml` 的 :5433（开发机当时 Docker 未起）；`server/.env`（gitignore）含 `DATABASE_URL=postgresql+asyncpg://eric@localhost:5432/imt`、`DEEPSEEK_API_KEY`、`jwt_secret`。要 docker 路径须先开 Docker Desktop。
- **测试夹具**：`conftest.py` 的 `db_session` 建表 + 用后 TRUNCATE + **`await engine.dispose()`**（pytest-asyncio 每测一新事件循环，asyncpg 连接绑 loop，不 dispose 则下个测试复用旧连接报 InterfaceError）。

## 命令

- 起服务：`uv run uvicorn app.main:app --port 8000`
- 测试：`uv run pytest`（**提交前必跑**；与 commit 分开，别让 `| tail` 吞退出码）
- 迁移：`uv run alembic revision --autogenerate -m "x" && uv run alembic upgrade head`
- 建管理员：`uv run python scripts/create_admin.py <email> <password>`
- 装依赖（遇本机代理报错清环境）：`env -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy uv add <pkg>`

## 验证

纯逻辑（markers / 切块 / token / 额度账本 / 费率 / 加密金标向量）用 pytest 单测；端点用 httpx ASGITransport + 依赖覆盖（deepseek / credits / daily）；翻译真实链路用 `scripts/smoke_translate.py` 或 curl 冒烟（领赠送 → translate → usage）。
