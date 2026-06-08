# P6 打点 + 错误上报 Implementation Plan

> REQUIRED SUB-SKILL: superpowers:executing-plans（Inline）。

**Goal:** 客户端把运营打点（翻译开始/完成/失败、块数、耗时）与错误上报到后端 `/v1/events`、`/v1/errors`，落库供管理台（P7）统计；隐私上只带 `host`、不带完整 URL/正文。

**Architecture:** `events(id, ts, user_id?, device_id?, type, host, props jsonb)` + `error_logs(id, ts, user_id?, device_id?, kind, message, context jsonb)`。两个 POST 端点接收批量数组、按 `current_user_optional` + `X-Device-Id` 归属、插入即返。客户端 `lib/telemetry.ts` 提供 `track()/reportError()`（fire-and-forget、绝不抛错、绝不带正文），由 `background.ts` 在翻译生命周期埋点。

**约定：** commit 中文 + Co-Authored-By；后端 `uv run`，pytest 与 commit 分开。

---

## Task 1: events / error_logs 模型 + 迁移

**Files:** `server/app/db/models.py`、迁移、`server/tests/conftest.py`

- [ ] **Step 1: 模型**（末尾；顶部 import 增 `from sqlalchemy.dialects.postgresql import JSONB`）
```python
class Event(Base):
    """运营打点：只存 host（不存完整 URL/正文）。props 放计数/耗时等非敏感字段。"""
    __tablename__ = "events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    user_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True)
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    props: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)


class ErrorLog(Base):
    __tablename__ = "error_logs"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    user_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True)
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    context: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
```
> 注意：本仓库已有名为 `Session` 的模型；这里 `Event` 与 translator 的 `Event` 类型同名但不同模块（`app.db.models.Event` vs `app.services.translator.Event`），互不影响（按模块限定引用）。
- [ ] **Step 2: 迁移** `uv run alembic revision --autogenerate -m "events_errorlogs" && uv run alembic upgrade head`
- [ ] **Step 3: conftest TRUNCATE 加 events, error_logs**
- [ ] **Step 4: Commit** — `P6: events/error_logs 模型 + 迁移`

---

## Task 2: /v1/events + /v1/errors 端点

**Files:** `server/app/routers/telemetry.py`(新)、`server/app/main.py`、`server/tests/test_telemetry_endpoints.py`(新)

- [ ] **Step 1: 写失败测试** `server/tests/test_telemetry_endpoints.py`
```python
import httpx
from httpx import ASGITransport
from sqlalchemy import func, select

from app.db.models import ErrorLog, Event
from app.main import app


def _c():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_post_events_inserts(db_session):
    async with _c() as c:
        r = await c.post("/v1/events", json={"events": [
            {"type": "translate_done", "host": "react.dev", "props": {"blocks": 42, "ms": 1200}},
            {"type": "translate_start", "host": "react.dev", "props": {"blocks": 42}},
        ]}, headers={"X-Device-Id": "dev1"})
        assert r.status_code == 200 and r.json()["stored"] == 2
    n = await db_session.scalar(select(func.count()).select_from(Event))
    assert n == 2


async def test_post_errors_inserts(db_session):
    async with _c() as c:
        r = await c.post("/v1/errors", json={"errors": [
            {"kind": "network", "message": "无法连通", "context": {"host": "x.com"}},
        ]}, headers={"X-Device-Id": "dev1"})
        assert r.status_code == 200 and r.json()["stored"] == 1
    n = await db_session.scalar(select(func.count()).select_from(ErrorLog))
    assert n == 1


async def test_empty_batch_ok(db_session):
    async with _c() as c:
        r = await c.post("/v1/events", json={"events": []})
        assert r.status_code == 200 and r.json()["stored"] == 0
```
- [ ] **Step 2: 跑（红）**
- [ ] **Step 3: 写实现** `server/app/routers/telemetry.py`
```python
from typing import Any, AsyncIterator

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import async_session
from app.db.models import ErrorLog, Event
from app.routers.deps import current_user_optional

router = APIRouter()


async def get_session() -> AsyncIterator[AsyncSession]:
    async with async_session() as s:
        yield s


class EventIn(BaseModel):
    type: str
    host: str | None = None
    props: dict[str, Any] = {}


class ErrorIn(BaseModel):
    kind: str
    message: str
    context: dict[str, Any] = {}


class EventsBody(BaseModel):
    events: list[EventIn] = []


class ErrorsBody(BaseModel):
    errors: list[ErrorIn] = []


@router.post("/v1/events")
async def post_events(
    body: EventsBody, request: Request,
    session: AsyncSession = Depends(get_session),
    user_id: int | None = Depends(current_user_optional),
):
    device_id = request.headers.get("x-device-id") or None
    for e in body.events:
        session.add(Event(user_id=user_id, device_id=device_id, type=e.type, host=e.host, props=e.props))
    await session.commit()
    return {"stored": len(body.events)}


@router.post("/v1/errors")
async def post_errors(
    body: ErrorsBody, request: Request,
    session: AsyncSession = Depends(get_session),
    user_id: int | None = Depends(current_user_optional),
):
    device_id = request.headers.get("x-device-id") or None
    for e in body.errors:
        session.add(ErrorLog(user_id=user_id, device_id=device_id, kind=e.kind, message=e.message, context=e.context))
    await session.commit()
    return {"stored": len(body.errors)}
```
`main.py` 挂载 `telemetry.router`。
- [ ] **Step 4: 跑（绿）** + 全量后端
- [ ] **Step 5: Commit** — `P6: /v1/events + /v1/errors 端点`

---

## Task 3: 客户端 telemetry + background 埋点

**Files:** `lib/telemetry.ts`(新)、`entrypoints/background.ts`(改)

- [ ] **Step 1: `lib/telemetry.ts`**
```typescript
// 运营打点 / 错误上报：fire-and-forget，绝不抛错、绝不阻断翻译、绝不带页面正文（只带 host + 计数）。
import { BACKEND_URL } from './config';
import { getDeviceId } from './device';
import { getAccessToken } from './auth';

async function headers(): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    h['X-Device-Id'] = await getDeviceId();
    const t = await getAccessToken();
    if (t) h.Authorization = `Bearer ${t}`;
  } catch {
    // 忽略
  }
  return h;
}

export function track(type: string, host: string | null, props: Record<string, unknown> = {}): void {
  void (async () => {
    try {
      await fetch(`${BACKEND_URL}/v1/events`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ events: [{ type, host, props }] }),
      });
    } catch {
      // fire-and-forget
    }
  })();
}

export function reportError(kind: string, message: string, context: Record<string, unknown> = {}): void {
  void (async () => {
    try {
      await fetch(`${BACKEND_URL}/v1/errors`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ errors: [{ kind, message, context }] }),
      });
    } catch {
      // fire-and-forget
    }
  })();
}
```
- [ ] **Step 2: `background.ts` 埋点**
  - import `{ track, reportError }` + `hostOf` 已有。
  - `start` 分支起翻译时记起点与时间戳：`const startedAt = Date.now(); const host = hostOf(port.sender?.url); track('translate_start', host, { blocks: msg.blocks.length });`
  - onDone：`track('translate_done', host, { blocks: msg.blocks.length, ms: Date.now() - startedAt });`
  - onError：`track('translate_error', host, { kind: failure.kind }); reportError(failure.kind, failure.message, { host });`
  （host/startedAt 在 start 分支闭包内捕获即可。）
- [ ] **Step 3: 编译** — `pnpm compile`
- [ ] **Step 4: Commit** — `P6 客户端: lib/telemetry.ts + background 翻译生命周期埋点`

---

## Task 4: 端到端验证 + 合并

- [ ] **Step 1: 后端全量 + 客户端单测/编译**
- [ ] **Step 2: curl** 直验端点落库：
```bash
cd server && uv run uvicorn app.main:app --port 8000 --log-level warning &
sleep 2
curl -s -H 'Content-Type: application/json' -H 'X-Device-Id: p6-dev' -d '{"events":[{"type":"translate_done","host":"react.dev","props":{"blocks":42,"ms":1100}}]}' http://localhost:8000/v1/events; echo
curl -s -H 'Content-Type: application/json' -H 'X-Device-Id: p6-dev' -d '{"errors":[{"kind":"network","message":"无法连通后端","context":{"host":"x.com"}}]}' http://localhost:8000/v1/errors; echo
psql -h localhost -p 5432 -d imt -tAc "select type,host,props from events where device_id='p6-dev'; select kind,message from error_logs where device_id='p6-dev';"
psql -h localhost -p 5432 -d imt -tAc "delete from events where device_id='p6-dev'; delete from error_logs where device_id='p6-dev';" >/dev/null
kill %1
```
Expected: `{"stored":1}` 两次；events/error_logs 各查到 1 行（host=react.dev / x.com，props/context 仅计数与 host）。
- [ ] **Step 3: 合并 main，删分支。**

---

## Self-Review
- 覆盖设计 P6：/v1/events、/v1/errors、客户端埋点、隐私脱敏（只 host）。
- 隐私：客户端只发 host + 计数/耗时/错误类，绝不发完整 URL/正文/Key。
- fire-and-forget：埋点失败不影响翻译。
- 已知后续：P7 管理台读 events/error_logs 做看板与日志检索；批量缓冲可后续优化（当前每事件一次 POST）。
