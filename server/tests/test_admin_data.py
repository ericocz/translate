import httpx
from httpx import ASGITransport

from app.core.security import create_admin_token, hash_password
from app.db.models import Admin, ErrorLog, Event, User
from app.main import app
from app.services.usage_repo import DailyUsageRepo


async def _admin_token(db_session):
    a = Admin(email="a@x.com", password_hash=hash_password("pw"))
    db_session.add(a)
    await db_session.commit()
    await db_session.refresh(a)
    return create_admin_token(a.id)


async def test_users_and_logs(db_session):
    tok = await _admin_token(db_session)
    u = User(email="u@x.com", password_hash="x")
    db_session.add(u)
    await db_session.commit()
    await db_session.refresh(u)
    await DailyUsageRepo(db_session).add(u.id, "2026-06-08", 100, 50, pages=2)
    db_session.add(Event(type="translate_done", host="react.dev", props={"blocks": 9}))
    db_session.add(ErrorLog(kind="network", message="boom", context={}))
    await db_session.commit()

    h = {"Authorization": f"Bearer {tok}"}
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        users = (await c.get("/admin/users", headers=h)).json()
        assert any(x["email"] == "u@x.com" for x in users)
        errors = (await c.get("/admin/errors", headers=h)).json()
        assert errors and errors[0]["kind"] == "network"
        events = (await c.get("/admin/events", headers=h)).json()
        assert events and events[0]["type"] == "translate_done"


async def test_stats_counts(db_session):
    tok = await _admin_token(db_session)
    db_session.add(Event(type="translate_done", host="x.com", props={}))
    await db_session.commit()
    h = {"Authorization": f"Bearer {tok}"}
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        st = (await c.get("/admin/stats", headers=h)).json()
        assert st["translations"] >= 1 and "topHosts" in st
