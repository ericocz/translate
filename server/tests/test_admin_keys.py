import httpx
from httpx import ASGITransport

from app.core.security import create_admin_token, hash_password
from app.db.models import Admin
from app.main import app


async def _admin_token(db_session):
    a = Admin(email="a@x.com", password_hash=hash_password("pw"))
    db_session.add(a)
    await db_session.commit()
    await db_session.refresh(a)
    return create_admin_token(a.id)


async def test_keys_crud_masked(db_session):
    tok = await _admin_token(db_session)
    h = {"Authorization": f"Bearer {tok}"}
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post("/admin/keys", json={"label": "main", "key": "sk-abcdef123456"}, headers=h)
        assert r.status_code == 200
        body = r.json()
        assert body["masked"].endswith("3456") and "abcdef" not in body["masked"]
        kid = body["id"]
        lst = (await c.get("/admin/keys", headers=h)).json()
        assert any(k["id"] == kid for k in lst) and all("key_value" not in k for k in lst)
        r2 = await c.patch(f"/admin/keys/{kid}", json={"status": "disabled"}, headers=h)
        assert r2.status_code == 200 and r2.json()["status"] == "disabled"
