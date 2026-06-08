import httpx
from httpx import ASGITransport

from app.core.security import hash_password
from app.db.models import Admin
from app.main import app


def _c():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_admin_login_and_guard(db_session):
    db_session.add(Admin(email="adm@x.com", password_hash=hash_password("adminpw")))
    await db_session.commit()
    async with _c() as c:
        assert (await c.get("/admin/stats")).status_code == 401  # 未带 token
        r = await c.post("/admin/login", json={"email": "adm@x.com", "password": "adminpw"})
        assert r.status_code == 200
        tok = r.json()["token"]
        r2 = await c.get("/admin/stats", headers={"Authorization": f"Bearer {tok}"})
        assert r2.status_code == 200


async def test_admin_login_bad_pw(db_session):
    db_session.add(Admin(email="adm@x.com", password_hash=hash_password("adminpw")))
    await db_session.commit()
    async with _c() as c:
        r = await c.post("/admin/login", json={"email": "adm@x.com", "password": "no"})
        assert r.status_code == 401
