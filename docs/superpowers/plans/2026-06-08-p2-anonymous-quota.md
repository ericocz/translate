# P2 匿名配额 + 闸门 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给未登录用户加「每页一次、每天 3 页」的免费配额闸门：后端按 (deviceId, 本地日, pageKey) 去重计数，超额时 `/v1/translate` 发 `quota` 事件（不调模型），popup 展示「今日 N/3 页」与超额引导文案。

**Architecture:** 后端新增 `anon_usage` 表 + `AnonQuotaRepo`（`check_and_count` 原子判定：本页已计→放行不计；今日不同 pageKey < 3→计并放行；否则拒绝）。`/v1/translate` 在流式开始前做闸门，拒绝则发 `quota` SSE 事件并结束；新增 `GET /v1/usage` 供 popup 读「已用/上限」。客户端：`background` 从 `port.sender.url` 算 `pageKey`（规范化去 fragment + cyrb53 哈希，URL 不出本机）传给 `lib/api.ts` 一并发后端；新增 `quota` 失败类型，经端口/`StatusReply.errorKind` 透到 popup 做「非报错」的柔和提示；popup 拉 `/v1/usage` 显示剩余页数。登录用户跳过配额留到 P3。

**Tech Stack:** 后端 FastAPI + SQLAlchemy async + Alembic + pytest（沿用 P0/P1）；客户端 TS/WXT + 纯函数 node `.mjs` 单测 + `pnpm compile`。

**前置：** P0/P1 已合入 main（后端 `/v1/translate` SSE 跑通、客户端已改调后端）。本机 dev 库为 Postgres.app 的 `imt`（见记忆 backend-server-dev-setup）。

**约定：** commit message 用中文，末尾加 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`（步骤省略，执行时带上）。后端命令在 `server/` 下用 `uv run`；跑 pytest 与 commit 分开，避免管道吞退出码。

---

## 关键设计点

- **「一次」单位 = 不同 `pageKey`**：`pageKey = cyrb53(origin + pathname + search)`（去掉 `#fragment`）。刷新/重进同一 URL → 同 pageKey → 不重复扣；沉降补抽 / 同页多批请求共享 pageKey → 只计一次；SPA 新路由 = 新 URL = 新 pageKey = 计一次（符合「每页一次」）。
- **隐私**：`pageKey` 在**客户端**算好哈希再发，完整 URL 不出本机；后端只存不透明哈希。延续「只存 host 不存全 URL」。
- **闸门时机**：在 `/v1/translate` 返回流之前 `await` 完成配额判定与计数；拒绝则流里只发 `quota` 事件、**不查缓存、不调模型**。
- **P2 全员匿名**：尚无登录（P3 才有），故闸门对所有请求生效——含开发自测。验证时用「换 deviceId / 清 anon_usage」绕过。
- **`quota` 非错误**：它是引导而非失败，popup 用柔和（非红）样式显示「今日 3 页已用完，登录后免费畅用」。
- **IP 软兜底**：`anon_usage.ip` 仅记录（`request.client.host`），P2 不据此硬卡。

---

## 文件结构（创建/修改）

```
server/
  app/db/models.py            # 改：新增 AnonUsage 模型
  alembic/versions/xxxx_*.py  # 新：anon_usage 迁移
  app/services/quota.py       # 新：AnonQuotaRepo（check_and_count / usage）+ QuotaDecision
  app/routers/translate.py    # 改：请求加 pageKey、读 X-Device-Id/IP、闸门 + quota 事件、get_anon_quota dep
  app/routers/usage.py        # 新：GET /v1/usage
  app/main.py                 # 改：挂载 usage 路由
  tests/test_quota.py         # 新：配额仓库 DB 集成测试
  tests/test_usage_endpoint.py# 新：/v1/usage 端点测试
  tests/test_translate_endpoint.py # 改：补一个 quota 闸门用例
lib/
  device.ts                   # 改：新增 pageKeyFromUrl（规范化 + cyrb53）
  api.ts                      # 改：translateViaBackend 增 pageKey 参数、body 带 pageKey、处理 quota 事件
  types.ts                    # 改：FailureKind 增 'quota'
  messages.ts                 # 改：ErrorMsg.failure.kind 增 'quota'；StatusReply 增 errorKind
entrypoints/
  background.ts               # 改：从 sender.url 算 pageKey 传入 translateViaBackend
  content.ts                  # 改：记 lastErrorKind，buildStatusReply 带 errorKind
  popup/App.tsx               # 改：拉 /v1/usage 显示「今日 N/3 页」+ quota 柔和提示
.test-pagekey.mjs             # 新：pageKeyFromUrl 规范化/哈希的 node 单测
```

---

## Task 1: `anon_usage` 模型 + 迁移

**Files:**
- Modify: `server/app/db/models.py`
- Create: `server/alembic/versions/<auto>_anon_usage.py`（autogenerate）

- [ ] **Step 1: 在 models.py 追加 AnonUsage**

`server/app/db/models.py` 顶部 import 增加 `UniqueConstraint`：
```python
from sqlalchemy import BigInteger, DateTime, Integer, String, Text, UniqueConstraint, func
```
文件末尾追加：
```python
class AnonUsage(Base):
    """匿名「每页一次」去重计数：一行 = 某设备某本地日翻译过的一个页面（pageKey 为客户端算好的哈希）。
    唯一约束保证同设备同日同页只占一行；当日不同 page_key 行数即「已用页数」。"""

    __tablename__ = "anon_usage"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    local_date: Mapped[str] = mapped_column(String(10), nullable=False)  # YYYY-MM-DD（用户时区）
    page_key: Mapped[str] = mapped_column(String(32), nullable=False)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)    # 软兜底，仅记录
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("device_id", "local_date", "page_key", name="uq_anon_device_date_page"),
    )
```

- [ ] **Step 2: 生成并应用迁移**

Run（在 `server/`）:
```bash
uv run alembic revision --autogenerate -m "anon_usage" && uv run alembic upgrade head
```
Expected: 日志 `Detected added table 'anon_usage'`，upgrade 成功。

- [ ] **Step 3: 核对表**

Run: `psql -h localhost -p 5432 -d imt -c "\d anon_usage"`
Expected: 列出 id/device_id/local_date/page_key/ip/created_at + 唯一约束 uq_anon_device_date_page。

- [ ] **Step 4: Commit**

```bash
git add server/app/db/models.py server/alembic/versions/
git commit -m "P2: anon_usage 模型 + 迁移（每页一次去重计数）"
```

---

## Task 2: 配额仓库 `AnonQuotaRepo`

**Files:**
- Create: `server/app/services/quota.py`
- Create: `server/tests/test_quota.py`

- [ ] **Step 1: 写失败测试**

`server/tests/test_quota.py`：
```python
from app.services.quota import AnonQuotaRepo, ANON_DAILY_PAGE_LIMIT


async def test_new_pages_count_until_limit(db_session):
    repo = AnonQuotaRepo(db_session)
    d1 = await repo.check_and_count("dev1", "2026-06-08", "pageA")
    assert d1.allowed and d1.used == 1
    d2 = await repo.check_and_count("dev1", "2026-06-08", "pageB")
    assert d2.allowed and d2.used == 2
    d3 = await repo.check_and_count("dev1", "2026-06-08", "pageC")
    assert d3.allowed and d3.used == 3
    d4 = await repo.check_and_count("dev1", "2026-06-08", "pageD")
    assert not d4.allowed and d4.used == 3  # 第 4 个新页被拒
    assert d4.limit == ANON_DAILY_PAGE_LIMIT


async def test_same_page_is_free(db_session):
    repo = AnonQuotaRepo(db_session)
    for _ in range(5):
        d = await repo.check_and_count("dev1", "2026-06-08", "pageA")
        assert d.allowed
    # 用满 3 个新页后，重复已计页仍放行
    await repo.check_and_count("dev1", "2026-06-08", "pageB")
    await repo.check_and_count("dev1", "2026-06-08", "pageC")
    assert (await repo.check_and_count("dev1", "2026-06-08", "pageA")).allowed
    assert not (await repo.check_and_count("dev1", "2026-06-08", "pageD")).allowed


async def test_per_device_and_per_day_isolated(db_session):
    repo = AnonQuotaRepo(db_session)
    for k in ("a", "b", "c"):
        await repo.check_and_count("dev1", "2026-06-08", k)
    # 另一设备、另一天都各自从 0 开始
    assert (await repo.check_and_count("dev2", "2026-06-08", "a")).allowed
    assert (await repo.check_and_count("dev1", "2026-06-09", "a")).allowed


async def test_usage_count(db_session):
    repo = AnonQuotaRepo(db_session)
    await repo.check_and_count("dev1", "2026-06-08", "a")
    await repo.check_and_count("dev1", "2026-06-08", "b")
    used, limit = await repo.usage("dev1", "2026-06-08")
    assert used == 2 and limit == ANON_DAILY_PAGE_LIMIT
```

`server/tests/conftest.py` 的 `db_session` 夹具 TRUNCATE 需带上新表（改一行）：把
```python
        await conn.execute(text("TRUNCATE translation_cache"))
```
改为
```python
        await conn.execute(text("TRUNCATE translation_cache, anon_usage"))
```

- [ ] **Step 2: 跑测试，预期失败**

Run: `cd server && uv run pytest tests/test_quota.py -q`
Expected: FAIL（ModuleNotFoundError: app.services.quota）

- [ ] **Step 3: 写实现**

`server/app/services/quota.py`：
```python
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AnonUsage

ANON_DAILY_PAGE_LIMIT = 3
QUOTA_MESSAGE = "今日免费 3 页已用完，登录后免费畅用"


@dataclass
class QuotaDecision:
    allowed: bool
    used: int          # 当日已用（不同 page_key 数）
    limit: int
    message: str = ""


class AnonQuotaRepo:
    """匿名配额：每设备每本地日按不同 page_key 计「页」，上限 ANON_DAILY_PAGE_LIMIT。
    已计过的页重复翻译不再计数（每页一次）。"""

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def _used(self, device_id: str, local_date: str) -> int:
        n = await self._s.scalar(
            select(func.count(func.distinct(AnonUsage.page_key))).where(
                AnonUsage.device_id == device_id, AnonUsage.local_date == local_date
            )
        )
        return int(n or 0)

    async def check_and_count(
        self, device_id: str, local_date: str, page_key: str, ip: str | None = None
    ) -> QuotaDecision:
        known = await self._s.scalar(
            select(AnonUsage.id).where(
                AnonUsage.device_id == device_id,
                AnonUsage.local_date == local_date,
                AnonUsage.page_key == page_key,
            )
        )
        used = await self._used(device_id, local_date)
        if known is not None:
            return QuotaDecision(True, used, ANON_DAILY_PAGE_LIMIT)
        if used < ANON_DAILY_PAGE_LIMIT:
            self._s.add(
                AnonUsage(device_id=device_id, local_date=local_date, page_key=page_key, ip=ip)
            )
            await self._s.commit()
            return QuotaDecision(True, used + 1, ANON_DAILY_PAGE_LIMIT)
        return QuotaDecision(False, used, ANON_DAILY_PAGE_LIMIT, QUOTA_MESSAGE)

    async def usage(self, device_id: str, local_date: str) -> tuple[int, int]:
        return await self._used(device_id, local_date), ANON_DAILY_PAGE_LIMIT
```

- [ ] **Step 4: 跑测试，预期通过**

Run: `cd server && uv run pytest tests/test_quota.py -q`
Expected: PASS（4 passed）

- [ ] **Step 5: Commit**

```bash
git add server/app/services/quota.py server/tests/test_quota.py server/tests/conftest.py
git commit -m "P2: 匿名配额仓库（每页一次 + 每日 3 页 + usage 计数）"
```

---

## Task 3: `/v1/translate` 接入配额闸门 + `quota` 事件

**Files:**
- Modify: `server/app/routers/translate.py`
- Modify: `server/tests/test_translate_endpoint.py`

- [ ] **Step 1: 改 translate.py**

请求模型增 `pageKey`：
```python
class TranslateRequest(BaseModel):
    blocks: list[BlockIn]
    localDate: str | None = None
    pageKey: str | None = None
```
增加配额仓库依赖（放在 `get_cache` 附近）：
```python
from datetime import date

from fastapi import Request
from app.services.quota import AnonQuotaRepo


async def get_anon_quota():
    async with async_session() as s:
        yield AnonQuotaRepo(s)
```
端点签名与函数体改为（闸门在返回流之前 await 完成）：
```python
@router.post("/v1/translate")
async def translate_endpoint(
    req: TranslateRequest,
    request: Request,
    cache=Depends(get_cache),
    quota=Depends(get_anon_quota),
    deepseek_stream=Depends(get_deepseek_stream),
):
    device_id = request.headers.get("x-device-id", "")
    ip = request.client.host if request.client else None
    local_date = req.localDate or date.today().isoformat()
    blocks = [SourceBlock(b.id, b.source) for b in req.blocks]

    # 匿名配额闸门（P2；P3 登录用户将在此跳过）。有 pageKey + deviceId 才计。
    decision = None
    if req.pageKey and device_id:
        decision = await quota.check_and_count(device_id, local_date, req.pageKey, ip)

    async def gen() -> AsyncIterator[str]:
        if decision is not None and not decision.allowed:
            yield _sse("quota", {
                "message": decision.message, "used": decision.used, "limit": decision.limit,
            })
            return
        async for ev in translate(
            blocks, cache=cache, deepseek_stream=deepseek_stream, api_key=settings.deepseek_api_key
        ):
            if isinstance(ev, BlockEvent):
                yield _sse("block", {"id": ev.id, "translated": ev.translated})
            elif isinstance(ev, DoneEvent):
                yield _sse("done", {})
            elif isinstance(ev, ErrorEvent):
                yield _sse("error", {"kind": ev.kind, "message": ev.message})

    return StreamingResponse(gen(), media_type="text/event-stream")
```

- [ ] **Step 2: 补端点测试（quota 闸门）**

`server/tests/test_translate_endpoint.py` 追加（用 fake quota 覆盖，验证拒绝时发 quota 事件、不译）：
```python
from app.routers.translate import get_anon_quota
from app.services.quota import QuotaDecision


class FakeQuotaDeny:
    async def check_and_count(self, *a, **k):
        return QuotaDecision(False, 3, 3, "今日免费 3 页已用完，登录后免费畅用")


async def test_translate_blocked_emits_quota(override):
    app.dependency_overrides[get_anon_quota] = lambda: FakeQuotaDeny()
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post(
                "/v1/translate",
                json={"blocks": [{"id": "b1", "source": "Hi"}], "pageKey": "p1"},
                headers={"X-Device-Id": "dev1"},
            )
        evs = parse_sse(resp.text)
        kinds = [e for e, _ in evs]
        assert "quota" in kinds
        assert "block" not in kinds and "done" not in kinds  # 拒绝即不译
    finally:
        app.dependency_overrides.pop(get_anon_quota, None)
```
（`override` 夹具已覆盖 `get_cache`/`get_deepseek_stream`；本用例再加 `get_anon_quota` 覆盖。已有的放行用例因不带 `pageKey` 而跳过闸门，仍照常 block+done。）

- [ ] **Step 3: 跑端点测试，预期通过**

Run: `cd server && uv run pytest tests/test_translate_endpoint.py -q`
Expected: PASS（2 passed）

- [ ] **Step 4: Commit**

```bash
git add server/app/routers/translate.py server/tests/test_translate_endpoint.py
git commit -m "P2: /v1/translate 接入匿名配额闸门 + quota 事件"
```

---

## Task 4: `GET /v1/usage` 端点

**Files:**
- Create: `server/app/routers/usage.py`
- Modify: `server/app/main.py`
- Create: `server/tests/test_usage_endpoint.py`

- [ ] **Step 1: 写失败测试**

`server/tests/test_usage_endpoint.py`：
```python
import httpx
import pytest
from httpx import ASGITransport

from app.main import app
from app.routers.translate import get_anon_quota


class FakeQuota:
    async def usage(self, device_id, local_date):
        return 2, 3


@pytest.fixture
def override_usage():
    app.dependency_overrides[get_anon_quota] = lambda: FakeQuota()
    yield
    app.dependency_overrides.clear()


async def test_usage_returns_used_and_remaining(override_usage):
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.get("/v1/usage?localDate=2026-06-08", headers={"X-Device-Id": "dev1"})
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"loggedIn": False, "used": 2, "limit": 3, "remaining": 1}
```

- [ ] **Step 2: 跑测试，预期失败**

Run: `cd server && uv run pytest tests/test_usage_endpoint.py -q`
Expected: FAIL（404 / 路由不存在）

- [ ] **Step 3: 写实现**

`server/app/routers/usage.py`：
```python
from datetime import date

from fastapi import APIRouter, Depends, Request

from app.routers.translate import get_anon_quota

router = APIRouter()


@router.get("/v1/usage")
async def usage_endpoint(request: Request, localDate: str | None = None, quota=Depends(get_anon_quota)):
    """popup 用：当前设备当日免费用量。P2 恒为匿名；P3 起 loggedIn 反映登录态。"""
    device_id = request.headers.get("x-device-id", "")
    local_date = localDate or date.today().isoformat()
    used, limit = await quota.usage(device_id, local_date)
    return {"loggedIn": False, "used": used, "limit": limit, "remaining": max(0, limit - used)}
```

`server/app/main.py` 挂载（与 translate 并列）：
```python
from app.routers import translate, usage

app = FastAPI(title="Immersive Translate Backend")
app.include_router(translate.router)
app.include_router(usage.router)
```

- [ ] **Step 4: 跑测试，预期通过**

Run: `cd server && uv run pytest tests/test_usage_endpoint.py -q`
Expected: PASS（1 passed）

- [ ] **Step 5: 全量后端测试**

Run: `cd server && uv run pytest -q`
Expected: 全绿（含 P0/P1 既有用例 + 新 quota/usage/translate）。

- [ ] **Step 6: Commit**

```bash
git add server/app/routers/usage.py server/app/main.py server/tests/test_usage_endpoint.py
git commit -m "P2: GET /v1/usage（设备当日免费用量）"
```

---

## Task 5: 客户端 `pageKeyFromUrl`

**Files:**
- Modify: `lib/device.ts`
- Create: `.test-pagekey.mjs`

- [ ] **Step 1: 写算法单测（内联实现）**

`.test-pagekey.mjs`：
```js
// 单测 pageKeyFromUrl：规范化（去 #fragment）+ cyrb53 哈希。与 lib/device.ts 内联保持一致。
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
function pageKeyFromUrl(url) {
  try {
    const u = new URL(url);
    return cyrb53(u.origin + u.pathname + u.search);
  } catch {
    return cyrb53(url || '');
  }
}

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name); } };

// 1) 去掉 #fragment：同页不同锚点 → 同 key
t('fragment 不影响', pageKeyFromUrl('https://x.com/a?b=1#sec1') === pageKeyFromUrl('https://x.com/a?b=1#sec2'));
// 2) query 参与身份：不同 query → 不同 key
t('query 区分', pageKeyFromUrl('https://x.com/a?b=1') !== pageKeyFromUrl('https://x.com/a?b=2'));
// 3) 路径区分
t('path 区分', pageKeyFromUrl('https://x.com/a') !== pageKeyFromUrl('https://x.com/b'));
// 4) 稳定
t('稳定', pageKeyFromUrl('https://x.com/a') === pageKeyFromUrl('https://x.com/a'));
// 5) 坏 URL 不抛
t('坏 URL 兜底', typeof pageKeyFromUrl('not a url') === 'string');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: 跑单测，预期通过**

Run: `node .test-pagekey.mjs`
Expected: `ALL PASS: 5 passed, 0 failed`

- [ ] **Step 3: 在 `lib/device.ts` 追加 `pageKeyFromUrl`（与上面算法一致）**

在 `lib/device.ts` 末尾追加：
```typescript
// 非加密快速哈希（cyrb53）：把页面 URL 压成短稳定 key，URL 不出本机（只发哈希给后端）。
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 页面身份 key：规范化（去 #fragment，保留 query）后哈希。用于匿名「每页一次」去重。 */
export function pageKeyFromUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return cyrb53(u.origin + u.pathname + u.search);
  } catch {
    return cyrb53(url);
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add lib/device.ts .test-pagekey.mjs
git commit -m "P2 客户端: pageKeyFromUrl（规范化 + cyrb53，URL 不出本机）"
```

---

## Task 6: 协议加 `quota` + api.ts 发 pageKey/收 quota + background 传 pageKey

**Files:**
- Modify: `lib/types.ts`, `lib/messages.ts`, `lib/api.ts`, `entrypoints/background.ts`

- [ ] **Step 1: `lib/types.ts` FailureKind 增 quota**

把
```typescript
export type FailureKind = 'network' | 'api' | 'auth' | 'unknown';
```
改为
```typescript
export type FailureKind = 'network' | 'api' | 'auth' | 'unknown' | 'quota';
```

- [ ] **Step 2: `lib/messages.ts` 增 quota 与 errorKind**

把 `ErrorMsg.failure` 的 kind 联合：
```typescript
  failure: { kind: 'network' | 'api' | 'auth' | 'unknown'; message: string };
```
改为
```typescript
  failure: { kind: 'network' | 'api' | 'auth' | 'unknown' | 'quota'; message: string };
```
在 `StatusReply` 接口里加一行（紧跟 `error?: string;` 之后）：
```typescript
  /** 错误/引导的分类（quota 表示免费额度用尽，popup 用柔和样式而非红色报错）。 */
  errorKind?: 'network' | 'api' | 'auth' | 'unknown' | 'quota';
```

- [ ] **Step 3: `lib/api.ts` 增 pageKey 参数 + 发 body + 处理 quota 事件**

签名改为：
```typescript
export function translateViaBackend(
  blocks: ApiBlock[],
  pageKey: string,
  handlers: ApiHandlers
): ApiClient {
```
请求体加 `pageKey`：
```typescript
        body: JSON.stringify({ blocks, localDate: localDateString(), pageKey }),
```
SSE 事件 switch 增 quota 分支（与 done/error 并列）：
```typescript
      } else if (ev.event === 'quota') {
        settled = true;
        handlers.onError(parseQuota(ev.data));
      }
```
并加解析函数（放在 `parseFailure` 旁）：
```typescript
function parseQuota(data: string): FailureInfo {
  try {
    const obj = JSON.parse(data) as { message?: string };
    return { kind: 'quota', message: obj.message ?? '今日免费额度已用完' };
  } catch {
    return { kind: 'quota', message: '今日免费额度已用完' };
  }
}
```

- [ ] **Step 4: `entrypoints/background.ts` 算 pageKey 并传入**

import 增加：
```typescript
import { pageKeyFromUrl } from '@/lib/device';
```
在 `start` 分支调用处（`const thisJob: ApiClient = translateViaBackend(` 那行）把 `msg.blocks,` 后补 pageKey 参数：
```typescript
      const thisJob: ApiClient = translateViaBackend(
        msg.blocks,
        pageKeyFromUrl(port.sender?.url),
        {
          onBlock: (id, translated) => send({ kind: 'block', id, translated }),
```

- [ ] **Step 5: 类型检查**

Run: `pnpm compile`
Expected: 报错仅来自 `content.ts`（buildStatusReply 尚未带 errorKind，但那是新增可选字段，不会报错）——预期**无错误**。若 `errorKind` 联合与 types 不一致报错，统一成同一联合。

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts lib/messages.ts lib/api.ts entrypoints/background.ts
git commit -m "P2 客户端: 协议加 quota + api 发 pageKey/收 quota 事件 + background 传 pageKey"
```

---

## Task 7: content 透 errorKind + popup 显示用量与配额提示

**Files:**
- Modify: `entrypoints/content.ts`
- Modify: `entrypoints/popup/App.tsx`

- [ ] **Step 1: `content.ts` 记录并上报 errorKind**

在 state 类型里 `lastError?: string;` 旁加 `lastErrorKind?: import('@/lib/types').FailureKind;`（或在顶部 import `FailureKind` 后用）。简洁起见在文件顶部 import：
```typescript
import type { FailureInfo } from '@/lib/messages';
```
（`messages.ts` 已引用该联合；也可直接用字符串字面量。）

在端口 `error` 分支（`state.lastError = msg.failure.message;` 那行附近）补记 kind：
```typescript
            state.lastError = msg.failure.message;
            state.lastErrorKind = msg.failure.kind;
```
并在 state 对象字面量初始化处与类型声明里加 `lastErrorKind`。`buildStatusReply` 里补：
```typescript
      if (state.lastError) reply.error = state.lastError;
      if (state.lastErrorKind) reply.errorKind = state.lastErrorKind;
```

- [ ] **Step 2: popup 拉 /v1/usage + 渲染**

`entrypoints/popup/App.tsx`：
- 顶部 import：
```typescript
import { BACKEND_URL } from '@/lib/config';
import { getDeviceId, localDateString } from '@/lib/device';
```
- 在 `PopupState` 加 `usage: { used: number; limit: number; remaining: number } | null;`，初始 `usage: null`。
- 加一个拉取函数并在 `refresh()` 里调用（与状态轮询同周期即可）：
```typescript
  const fetchUsage = useCallback(async () => {
    try {
      const deviceId = await getDeviceId();
      const r = await fetch(`${BACKEND_URL}/v1/usage?localDate=${localDateString()}`, {
        headers: { 'X-Device-Id': deviceId },
      });
      if (r.ok) return (await r.json()) as { used: number; limit: number; remaining: number };
    } catch {
      // 后端不可达时不显示用量，不报错。
    }
    return null;
  }, []);
```
在 `refresh` 末尾把 usage 一并 set（`setS(...)` 时带上 `usage: await fetchUsage()`）。

- 渲染：在 `status` 错误分支里，对 quota 用柔和样式（不红）。把现有
```tsx
      {err ? (
        <div className="status status--err">
          <span className="dot dot--err" />
          <span>{err}</span>
        </div>
      ) : !s.enabled ? (
```
改为
```tsx
      {err && st?.errorKind === 'quota' ? (
        <div className="status">
          <span className="dot dot--off" />
          <span>{err}</span>
        </div>
      ) : err ? (
        <div className="status status--err">
          <span className="dot dot--err" />
          <span>{err}</span>
        </div>
      ) : !s.enabled ? (
```
- 在 `foot` 的 `foot-hint` 处展示免费用量（未登录恒显示；P3 起按登录态隐藏）。把
```tsx
        <span className="foot-hint">
          {s.enabled ? (err ? '关掉再开可整页重译' : '自动翻译已开启') : '开启即整页翻译'}
        </span>
```
改为
```tsx
        <span className="foot-hint">
          {s.usage
            ? `免费 ${s.usage.used}/${s.usage.limit} 页 · 登录后无限`
            : s.enabled
              ? (err ? '关掉再开可整页重译' : '自动翻译已开启')
              : '开启即整页翻译'}
        </span>
```

- [ ] **Step 3: 类型检查**

Run: `pnpm compile`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add entrypoints/content.ts entrypoints/popup/App.tsx
git commit -m "P2 客户端: content 透 errorKind + popup 显示今日 N/3 页与配额柔和提示"
```

---

## Task 8: 端到端验证

**Files:** 无

- [ ] **Step 1: 后端全量测试**

Run: `cd server && uv run pytest -q`
Expected: 全绿。

- [ ] **Step 2: 客户端单测 + 编译**

Run: `node .test-sse.mjs && node .test-pagekey.mjs && node .test-restore-wrapper.mjs && pnpm compile`
Expected: 三个 mjs 全 ALL PASS；compile 无错误。

- [ ] **Step 3: 配额逻辑用 curl 直验（不依赖浏览器）**

```bash
cd server && uv run uvicorn app.main:app --port 8000 --log-level warning &
sleep 2
H='-H Content-Type:application/json -H X-Device-Id:smoke-dev-1'
B(){ curl -s -N $H -d "{\"blocks\":[{\"id\":\"b1\",\"source\":\"Submit\"}],\"pageKey\":\"$1\",\"localDate\":\"2026-06-08\"}" http://localhost:8000/v1/translate | tr '\n' ' '; echo; }
echo "页1:"; B p1
echo "页1再来(应免费放行):"; B p1
echo "页2:"; B p2
echo "页3:"; B p3
echo "页4(应 quota):"; B p4
echo "用量:"; curl -s -H X-Device-Id:smoke-dev-1 "http://localhost:8000/v1/usage?localDate=2026-06-08"; echo
kill %1
```
Expected:
- 页1/页1再来/页2/页3：流里有 `event: block` + `event: done`（译出「提交」）。
- 页4：流里**只有** `event: quota`（含「今日免费 3 页已用完…」），无 block。
- 用量：`{"loggedIn":false,"used":3,"limit":3,"remaining":0}`。
- 重置：`psql -h localhost -p 5432 -d imt -c "delete from anon_usage where device_id='smoke-dev-1';"`

- [ ] **Step 4: （可选）浏览器 e2e**

后端起着 + `pnpm build` + 在能上网的调试 Chrome 重载 `output/chrome-mv3`：翻 3 个不同页正常；第 4 个新页不译、popup 显示「今日 3 页已用完，登录后免费畅用」（柔和非红）；popup 页脚显示「免费 N/3 页 · 登录后无限」；刷新已翻页不增计数。

- [ ] **Step 5: 收尾 commit（若验证中有微调）**

```bash
git add -A && git commit -m "P2: 端到端验证（curl 配额闸门 + 用量）"  # 无改动则跳过
```

---

## Self-Review 记录

- **Spec 覆盖**：设计文档 P2——`anon_usage`（Task 1）、每页一次/3 页一天（Task 2 仓库 + Task 3 闸门）、`quota` 事件（Task 3）+ popup 引导（Task 7）、`GET /v1/usage`（Task 4）、客户端发 pageKey（Task 5/6）、IP 软兜底（Task 1 列 + Task 3 记录不卡）。
- **占位扫描**：无 TBD；每个改代码步骤给完整代码/精确编辑 + 命令。
- **类型一致**：`FailureKind`（types.ts）= `messages.ts` 的 kind 联合 = `StatusReply.errorKind`，三处含 `'quota'`；`translateViaBackend(blocks, pageKey, handlers)` 新签名与 background 调用一致；`QuotaDecision.{allowed,used,limit,message}` 跨仓库/端点/测试一致。
- **隐私/铁律**：pageKey 客户端哈希、URL 不出本机；DeepSeek Key 仍仅服务端；闸门拒绝时不调模型（省 token）。
- **已知后续**：P2 全员匿名（含自测），登录用户跳过配额到 P3；`/v1/usage` 的 `loggedIn` 恒 false 到 P3；配额判定非强事务（并发新页极端下可能略超 3），单用户/低并发可接受，P3/P5 再按需加锁。
```
