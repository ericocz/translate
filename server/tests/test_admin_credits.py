from decimal import Decimal

import httpx
from httpx import ASGITransport

from app.core.security import create_admin_token, hash_password
from app.db.base import async_session
from app.db.models import Admin
from app.main import app
from app.services.credit_repo import CreditRepo, user_owner


async def _admin_token(db_session):
    a = Admin(email="a@x.com", password_hash=hash_password("pw"))
    db_session.add(a)
    await db_session.commit()
    await db_session.refresh(a)
    return create_admin_token(a.id)


def _client():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_admin_grants_and_accumulates(db_session):
    tok = await _admin_token(db_session)
    h = {"Authorization": f"Bearer {tok}"}
    async with _client() as c:
        r1 = await c.post("/admin/credits/grant", headers=h, json={"userId": 42, "amount": "5"})
        r2 = await c.post("/admin/credits/grant", headers=h, json={"userId": 42, "amount": "3"})
    assert r1.json() == {"ok": True, "owner": "u:42", "amount": 5.0, "balance": 5.0}
    assert r2.json()["balance"] == 8.0
    # 跨 session 落库可见
    async with async_session() as s:
        assert await CreditRepo(s).get_balance(user_owner(42)) == Decimal("8")


async def test_admin_grant_idempotent_with_ref(db_session):
    tok = await _admin_token(db_session)
    h = {"Authorization": f"Bearer {tok}"}
    async with _client() as c:
        await c.post("/admin/credits/grant", headers=h, json={"userId": 7, "amount": "5", "ref": "r1"})
        r2 = await c.post("/admin/credits/grant", headers=h, json={"userId": 7, "amount": "5", "ref": "r1"})
    assert r2.json()["balance"] == 5.0  # 同 ref 重投不翻倍


async def test_admin_refund_negative_amount(db_session):
    tok = await _admin_token(db_session)
    h = {"Authorization": f"Bearer {tok}"}
    async with _client() as c:
        await c.post("/admin/credits/grant", headers=h, json={"owner": "u:9", "amount": "10"})
        r = await c.post("/admin/credits/grant", headers=h, json={"owner": "u:9", "amount": "-4"})
    assert r.json()["balance"] == 6.0


async def test_admin_grant_requires_target(db_session):
    tok = await _admin_token(db_session)
    h = {"Authorization": f"Bearer {tok}"}
    async with _client() as c:
        r = await c.post("/admin/credits/grant", headers=h, json={"amount": "5"})
    assert r.status_code == 400


async def test_admin_grant_zero_rejected(db_session):
    tok = await _admin_token(db_session)
    h = {"Authorization": f"Bearer {tok}"}
    async with _client() as c:
        r = await c.post("/admin/credits/grant", headers=h, json={"userId": 1, "amount": "0"})
    assert r.status_code == 400


async def test_admin_grant_requires_auth(db_session):
    async with _client() as c:
        r = await c.post("/admin/credits/grant", json={"userId": 1, "amount": "5"})
    assert r.status_code == 401
