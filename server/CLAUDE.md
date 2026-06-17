# server/CLAUDE.md —— FastAPI 后端

「秒懂翻译 / aha translate」的后端，拥有「翻译这件事」的全部业务。仓库总览见 [`../CLAUDE.md`](../CLAUDE.md)。

**为什么服务端化**：原本是纯客户端自用——DeepSeek Key 随构建注入、提示词 / 流水线全在扩展内。要公开上架就有硬伤：① Key 解包即被盗用；② 没账号 / 额度 / 记账 / 打点，挡不住刷量也看不到线上。故把「翻译流水线 + 密钥 + 账号 + 额度 + 记账 + 收单」整体收进后端，扩展退化为「DOM 端 + API 客户端」。译文**不在服务端留存**（隐私）——缓存改到客户端本地，命中不发服务端、不计费。

## 技术栈

- Python **3.12**（uv 锁定；机器默认 3.14 生态兼容差，用 `uv venv --python 3.12`）。
- FastAPI（async）+ SQLAlchemy 2.0 async + asyncpg + Alembic 迁移；PyJWT + argon2-cffi；pytest + pytest-asyncio。
- SSE 用 `StreamingResponse` 手写 `event:` / `data:` 帧。
- **uv 直连官方 PyPI**（作者有 VPN、服务器部署在香港；原清华镜像 `[[tool.uv.index]]` 已撤）。

## 模型：DeepSeek V4 Flash

调用 `deepseek-v4-flash`（`app/core/hashing.py` 的 `MODEL`），关思考、稳定前缀、真实 usage。1M 上下文 / 384K 输出上限、成本价 ¥1/¥2（输入 / 输出，每 M token）。**走平台 key 的翻译按成本价 ×1.3（+30% 服务费）扣 credits**（`pricing.py` 的 `SERVICE_FEE_RATE`，平台唯一盈利来源；BYOK 客户端直连不经此处、不计费）。**模型能力、参数、前缀缓存、关思考的完整认知见 [`deepseek-v4-flash.md`](deepseek-v4-flash.md)**——调模型 / 改 `deepseek.py` / 动费率前先读它。

## 铁律（模型侧，逐条对应客户端旧约束）

1. **系统提示词逐字节稳定**（`app/core/prompt.py` 唯一来源，禁止动态拼接）——命中 DeepSeek 前缀缓存（cache-hit 价仅 miss 的 1/50）。
2. **显式关思考**：请求体顶层 `thinking: {type: "disabled"}`（V4 Flash 默认开思考；关掉后首 token 快、不产 reasoning_tokens，且 `temperature` 才生效——思考模式下采样参数无效）。
3. **按 token 预算装箱 + 有限并发**（`batch_by_token_budget`：累计 `estimate_tokens(src)` ≤ `OUTPUT_TOKEN_BUDGET`，正常网页一次请求、超长才分片，配合 `deepseek.MAX_OUTPUT_TOKENS=384000` 防截断）；**按 source 去重**。
4. **`[[id]]` 流式切块**：模型逐 token 返回、标记常被拆散——在**完整缓冲**上重扫（`block_splitter.py`）；正则字符类**必须含 `.`**（沉降补抽 / SPA 用 `r{batch}.b{n}`）。
5. **标记平衡校验**（`markers.py`，与客户端等价）——决定 `success` 计数与「全失败才报错」；校验不过的块仍原样回送、由客户端再校验。
6. **真实 usage**：请求带 `stream_options.include_usage`，取末块 `usage` 计 Token、缺失时 `estimate_tokens` 兜底；**只对服务端实际翻译的块记账**（命中本地缓存的块根本不到服务端）。
7. **API Key 只在服务端 env**（`app/core/config.py`，绝不下发客户端、绝不入日志 / 事件）。**例外仅 BYOK**：买断用户自带 key 存其客户端、直连各 provider，平台 key 仍只在服务端。
8. **DeepSeek 直连**：httpx `trust_env=False`（DeepSeek 是中国服务无需代理，绕开开发机个人 SOCKS 代理、省 socksio 依赖）。
9. **应用层加密（可选）**：见 `X-Eph-Pub` 头则 ECDH(P-256)+HKDF 派生会话密钥（`app/core/crypto.py`，私钥在 env），解密 `ct` 原文 / 加密 `ct` 译文，及解密 auth 的 email/password。**只加密叶子字段**，SSE 信封与标记校验仍在明文上做；**非 E2E**（解密后才发模型）。无头＝明文路径（dev / 测试）。

## 额度模型（商业化底座）

**无匿名 / 免费配额**——装好扩展初始**零额度**，必须先有额度才能翻。额度账户以 `owner` 字符串为键（`credit_repo.py`：`user_owner(id)="u:{id}"`、`device_owner(did)="d:{did}"`），登录用户与未注册设备共用同一套账本。三种来源：

- **赠送 ¥2**：`POST /v1/grant/gift` 幂等发（一设备一次），不需注册。**防薅**：幂等键优先 `gift:inst:{instanceID}`（前端 `chrome.instanceID`——清 storage 免疫、须卸载重装才变），故「清缓存换 deviceId 反复领」被同一 instanceID 拦下；缺 X-Instance-Id 才回退 `gift:d:{deviceId}`。额度仍发到 device owner。
- **充值 credits**：须注册（余额要跨设备 / 找回）。
- **买断 $9.99**：解锁 **BYOK**（自带任意模型 / key、客户端直连），**不送平台额度**——已落地，架构见 [`../front/CLAUDE.md`](../front/CLAUDE.md) 的「BYOK」节。

翻译统一门控（`translate.py`）：owner 余额 > 0 才翻、按 `cost_micro`（×1.3）实耗扣；无账户或余额 ≤ 0 → 发 `quota`、不翻。**已删 freemium**：原「匿名每天 3 页」+「登录无 credits 的梯度限流」连同 `quota.py`/`tier.py`/`tier_repo.py` 与 `anon_usage`/`quota_tier` 表全部下线。

## 模块地图

```
app/
  core/    config.py(Settings/env) · prompt.py(SYSTEM_PROMPT) · hashing.py(MODEL + 版本键 sha256)
           tokens.py(轻量 token 估算) · security.py(argon2 + JWT access/admin + refresh 哈希) · crypto.py(ECDH+HKDF+AES-GCM 会话加密)
  db/      base.py(engine/async_session/Base) · models.py(全部表)
  services/ markers.py · block_splitter.py · deepseek.py(请求体 + SSE + Usage 捕获 + 错误分类)
           translator.py(编排 → 事件流 Block/Done/Error/UsageEvent) · usage_repo.py(daily_usage 统计)
           credit_repo.py(额度账本：owner 键、幂等发放 / 扣减 / 余额；user_owner / device_owner) · pricing.py(cost_micro = 成本价 ×SERVICE_FEE_RATE=1.3)
           auth.py · creem.py(Creem webhook HMAC 验签 + checkout.completed 解析) · redeem_repo.py(买断注册码幂等签发) · email.py(EmailSender 接口 + ResendEmailSender HTTP 驱动 + make_email_sender 工厂：配 resend_api_key+email_from 则真发、否则退化 LogEmailSender 占位不丢单)
  routers/ deps.py(current_user_optional) · translate.py(owner 额度门控) · usage.py(余额 + 领赠送 /v1/grant/gift) · auth.py · telemetry.py · admin.py · billing.py(Creem webhook 收单)
  main.py  挂载全部 router + /health
alembic/   迁移
scripts/   create_admin.py(建管理员) · gen_session_keypair.py(生成应用层加密密钥对) · smoke_translate.py(真实链路冒烟)
```

## 数据模型（Postgres）

`users` / `sessions`（账号 + refresh 哈希）· `daily_usage`（每用户每日 token + pages，**登录用户统计用、不再做门控**）· `events` / `error_logs`（打点 / 错误，**只存 host**）· `admins` / `upstream_keys`（管理台）· `credit_accounts` / `credit_txns`（额度余额 + 流水，主键 / 索引为 **`owner` 字符串**＝`u:{id}` | `d:{deviceId}`，整数 micro-¥=1e-6 元，`idempotency_key` 唯一防重复发放）· `redeem_codes`（买断注册码：`source_ref`=支付订单 id 唯一防重投只签一张）。

> 译文**不在服务端留存**：原跨用户共享缓存已下线（隐私），缓存改为客户端 IndexedDB 本地层，命中本地的块根本不发服务端、不计费。

## API 表面

- `POST /v1/translate`（SSE：block / done / error / quota；**owner 余额 > 0 才翻、按 ×1.3 扣 credits；无账户或余额 ≤0 发 quota、不翻**；结束发 UsageEvent，登录用户另写 daily_usage；带 `X-Eph-Pub` 头则收发 `ct` 密文）
- `GET /v1/usage`（返 owner `balance` + `hasAccount` + 登录态；登录另返 `tokensToday`）
- `POST /v1/grant/gift`（发赠送 ¥2=2,000,000 micro-¥；防薅幂等键优先 `X-Instance-Id`（chrome.instanceID）、缺则回退 `X-Device-Id`；缺 deviceId 拒绝）
- `POST /v1/auth/{register,login,refresh,logout}`（register / login 带 `X-Eph-Pub` 头则邮箱 / 密码走 `ct`）
- `POST /v1/billing/creem/webhook`（海外买断收单：`creem-signature` HMAC-SHA256 验签 → `checkout.completed` 解析 → 按订单 id 幂等签发注册码 → **Resend 发码邮件**（发信失败吞掉不丢单、码已落库可重投/手动补发）；非买断完成事件回 200 忽略、验签失败回 400）。**发起购买不在后端**：D-18 用 Creem **静态 payment link**（前端 popup 挂 `WXT_BUYOUT_URL` 超链接跳转），后端只收 webhook。
- `POST /v1/events`、`POST /v1/errors`
- `/admin/{login,stats,users,errors,events,keys}`（管理员 JWT `scope:admin`；users 返 `balanceMicro`；keys 响应脱敏，绝不回完整 Key）

## 关键流程

- **翻译**：鉴权识别身份 → 命中客户端本地缓存的块根本不到这里 → **算 owner（登录 `u:{id}`、否则 `d:{deviceId}`）→ 查余额 > 0**（否则发 `quota`、不翻）→ 按 source 去重 → 按 token 预算分批并发调 DeepSeek → 切块 + 标记校验 → `UsageEvent` 时**按 `cost_micro`（×1.3）实耗扣 owner credits**；登录用户另记 `daily_usage`（统计）。
- **额度三来源**：赠送（`/v1/grant/gift` 绑设备幂等）/ 充值（须注册）/ 买断（解锁 BYOK、不进额度）。**无账户 = 零额度 = 不能翻**，前端引导领赠送 / 充值 / 买断。
- **BYOK（已落地）**：买断用户自带模型 key，**客户端 SW 直连各 provider**（提示词 / 切块 / token 估算搬到前端 `lib/local-engine/`），不经本后端、不计费。激活＝`POST /v1/redeem/verify` 验码绑设备。**双端一致性**：切块 / token 估算「Python 一份、TS 一份」，金标向量 `tests/test_golden_vectors.py` 与前端 `front/test-vectors/local-engine.json` 共读对齐——改翻译协议须两端同步。架构见 [`../front/CLAUDE.md`](../front/CLAUDE.md)「BYOK」节。

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
