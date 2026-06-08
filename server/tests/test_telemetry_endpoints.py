import httpx
from httpx import ASGITransport
from sqlalchemy import func, select

from app.db.models import ErrorLog, Event
from app.main import app


def _c():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_post_events_inserts(db_session):
    async with _c() as c:
        r = await c.post(
            "/v1/events",
            json={"events": [
                {"type": "translate_done", "host": "react.dev", "props": {"blocks": 42, "ms": 1200}},
                {"type": "translate_start", "host": "react.dev", "props": {"blocks": 42}},
            ]},
            headers={"X-Device-Id": "dev1"},
        )
        assert r.status_code == 200 and r.json()["stored"] == 2
    n = await db_session.scalar(select(func.count()).select_from(Event))
    assert n == 2


async def test_post_errors_inserts(db_session):
    async with _c() as c:
        r = await c.post(
            "/v1/errors",
            json={"errors": [{"kind": "network", "message": "无法连通", "context": {"host": "x.com"}}]},
            headers={"X-Device-Id": "dev1"},
        )
        assert r.status_code == 200 and r.json()["stored"] == 1
    n = await db_session.scalar(select(func.count()).select_from(ErrorLog))
    assert n == 1


async def test_empty_batch_ok(db_session):
    async with _c() as c:
        r = await c.post("/v1/events", json={"events": []})
        assert r.status_code == 200 and r.json()["stored"] == 0
