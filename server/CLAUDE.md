# server/CLAUDE.md —— FastAPI 后端

本目录是「沉浸式翻译」的后端，拥有「翻译这件事」的全部业务。仓库总览见 [`../CLAUDE.md`](../CLAUDE.md)，产品设计见《[../产品设计-服务端化与账号体系.md](../产品设计-服务端化与账号体系.md)》，分阶段计划见 `../docs/superpowers/plans/`（P0–P8）。

---

## 技术栈

- Python **3.12**（uv 锁定；机器默认 3.14，生态兼容性差，用 `uv venv --python 3.12`）。
- FastAPI（async）+ SQLAlchemy 2.0 async + asyncpg + Alembic 迁移；PyJWT + argon2-cffi；pytest + pytest-asyncio。
- SSE 用 `StreamingResponse` 手写 `event:`/`data:` 帧。
- **uv 默认索引切清华镜像**（`pyproject.toml` 的 `[[tool.uv.index]]`，pypi.org 直连被墙）。

## 铁律（服务端侧，逐条对应客户端旧约束）

1. **系统提示词逐字节稳定**（`app/core/prompt.py` 唯一来源，禁止动态拼接）——命中 DeepSeek 前缀缓存（hit 价 ¥0.02 的来源）。
2. **显式关思考**：请求体顶层 `thinking: {type:'disabled'}`（`deepseek-v4-flash` 默认开思考）。
3. **按 token 预算装箱 + 有限并发**（`batch_by_token_budget`：累计 `estimate_tokens(src)` ≤ `OUTPUT_TOKEN_BUDGET`，正常文章一次请求、超长才分片，配合 `deepseek.MAX_OUTPUT_TOKENS` 防截断）；**按 source 去重**。
4. **`[[id]]` 流式切块**：模型逐 token 返回、标记常被拆散——在**完整缓冲**上重扫（`block_splitter.py`）；正则字符类**必须含 `.`**（沉降补抽 / SPA 用 `r{batch}.b{n}`）。
5. **标记平衡校验**（`markers.py`，与客户端等价）——决定 `success` 计数与「全失败才报错」；服务端不再写缓存（D-11；原样回显 / 校验不过仍回送、由客户端再校验）。
6. **真实 usage**：请求带 `stream_options.include_usage`，取末块 `usage` 计 Token、接口缺失时 `estimate_tokens` 兜底；**只对服务端实际翻译的块记账**（命中本地缓存的块由客户端拦下、根本不发服务端，D-11）。
7. **API Key 只在服务端 env**（`app/core/config.py`，绝不下发客户端、绝不入日志 / 事件）。
8. **DeepSeek 直连**：httpx `trust_env=False`（DeepSeek 是中国服务，无需代理；绕开开发机个人 SOCKS 代理，省 socksio 依赖）。
9. **应用层加密（D-13）**：见 `X-Eph-Pub` 头则 ECDH(P-256)+HKDF 派生会话密钥（`app/core/crypto.py`，私钥 `session_private_key` 在 env），解密 `ct` 原文 / 加密 `ct` 译文（`/v1/translate`），及解密 auth 的 email/password（`ct`，AAD=`auth`）；**只加密叶子字段**，SSE 信封与标记校验仍在明文上做；**非 E2E**（解密后才发模型）。无头＝明文路径（dev / 现有测试）。返回的 token 仍走明文头（残留）。

## 模块

```
app/
  core/    config.py(Settings/env) · prompt.py(SYSTEM_PROMPT) · hashing.py(版本键+内容寻址键 sha256)
           tokens.py(轻量 token 估算) · security.py(argon2 + JWT access/admin + refresh 哈希) · crypto.py(D-13 ECDH+HKDF+AES-GCM 会话加密)
  db/      base.py(engine/async_session/Base) · models.py(全部表)
  services/ markers.py · block_splitter.py · deepseek.py(请求体+SSE+Usage 捕获+错误分类)
           translator.py(编排→事件流: Block/Done/Error/UsageEvent)
           quota.py(匿名每页一次/3 页天) · usage_repo.py(daily_usage) · tier.py(梯度限流纯函数) · tier_repo.py · auth.py · credit_repo.py(credits 账本: 幂等发放/扣减/余额)
  routers/ deps.py(current_user_optional) · translate.py · usage.py · auth.py · telemetry.py · admin.py
  main.py  挂载全部 router + /health
alembic/   迁移；scripts/create_admin.py 建管理员
```

## 数据模型（Postgres）

`anon_usage`（匿名每页去重）· `users` / `sessions`（账号 + refresh 哈希）· `daily_usage`（每用户每日 token + pages）· `quota_tier`（梯度限流状态机 + notice）· `events` / `error_logs`（打点 / 错误，只存 host）· `admins` / `upstream_keys`（管理台）· `credit_accounts` / `credit_txns`（预付额度余额 + 流水，整数 micro-¥=1e-6 元，`idempotency_key` 唯一防重复发放；尚未接入翻译流）。

> D-11：原 `translation_cache` 跨用户共享缓存已下线——隐私上不在服务端留存用户译文；缓存改为客户端 IndexedDB 本地层（见 front），命中本地的块根本不发服务端、不计费。

## API 表面

- `POST /v1/translate`（SSE：block/done/error/quota；登录跳匿名配额、超日上限发 quota；结束发 UsageEvent 写 daily_usage；**带 `X-Eph-Pub` 头则收发 `ct` 密文**，D-13）
- `GET /v1/usage`（匿名返页配额；登录返 tokensToday/cap/notice）
- `POST /v1/auth/{register,login,refresh,logout}`（register/login 带 `X-Eph-Pub` 头则邮箱/密码走 `ct`，D-13）
- `POST /v1/events`、`POST /v1/errors`
- `/admin/{login,stats,users,errors,events,keys}`（管理员 JWT `scope:admin`；keys 响应脱敏，绝不回完整 Key）

## 关键流程

- **翻译**：鉴权识别身份 → 缓存优先（命中即回 + 记 token）→ 去重 → 分批并发调 DeepSeek → 切块 + 标记校验 → 写缓存（本地估算 token）→ `UsageEvent`。
- **匿名配额**：`(deviceId, localDate, pageKey)` 去重；不同 pageKey ≥3 且新页 → `quota`。同页刷新不扣。
- **登录跳配额**：`current_user_optional` 非空则不计匿名配额；改受**梯度限流**约束。
- **Token 记账**：未命中以接口 `usage` 为准、命中读缓存里 token；都累加进 `daily_usage`（缓存命中也记账）。
- **梯度限流**：`tier.py` 纯函数按「固定日 Token 上限」分档；连续顶格降档、连续达标升档；拦截即时经 `quota` 提醒，升降档经 `quota_tier.notice` → `/v1/usage` 取走。

## 本地开发环境（重要）

- **dev 库用本机 Postgres.app 的 `imt`(:5432)**，不是 `docker-compose.yml` 的 :5433（开发机当时 Docker 未起）；`server/.env`（gitignore）含 `DATABASE_URL=postgresql+asyncpg://eric@localhost:5432/imt`、`DEEPSEEK_API_KEY`、`jwt_secret`。要 docker 路径需先开 Docker Desktop。
- **测试夹具**：`conftest.py` 的 `db_session` 建表 + 用后 TRUNCATE + **`await engine.dispose()`**（pytest-asyncio 每测一新事件循环，asyncpg 连接绑 loop，不 dispose 下个测试复用旧连接报 InterfaceError）。
- 建管理员：`uv run python scripts/create_admin.py <email> <password>`。

## 命令

- 起服务：`uv run uvicorn app.main:app --port 8000`
- 测试：`uv run pytest`（提交前必跑；pytest 与 commit 分开，别让 `| tail` 吞退出码）
- 迁移：`uv run alembic revision --autogenerate -m "x" && uv run alembic upgrade head`
- 装依赖（清华镜像，遇代理报错清环境）：`env -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy uv add <pkg>`

## 验证

纯逻辑（markers / 切块 / token / 限流状态机 / 配额）用 pytest 单测；端点用 httpx ASGITransport + 依赖覆盖（fake cache / deepseek / quota / daily / tier）；翻译真实链路用 curl 冒烟（注册 → translate → usage）。
