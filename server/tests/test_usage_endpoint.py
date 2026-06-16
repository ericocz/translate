from types import SimpleNamespace

import httpx
import pytest
from httpx import ASGITransport

from app.main import app
from app.routers.deps import current_user_optional
from app.routers.translate import get_credits, get_daily_usage


class FakeCredits:
    def __init__(self, balance=0, has_account=False):
        self._balance = balance
        self._has = has_account

    async def get_account(self, owner):
        return SimpleNamespace(owner=owner, balance_micro=self._balance) if self._has else None

    async def grant(self, owner, amount, kind="grant", idempotency_key=None):
        self._has = True
        self._balance += amount
        return self._balance


class FakeDailyUsage:
    async def tokens_today(self, user_id, local_date):
        return 1234


@pytest.fixture
def override_usage():
    app.dependency_overrides[get_credits] = lambda: FakeCredits(balance=1_500_000, has_account=True)
    app.dependency_overrides[get_daily_usage] = lambda: FakeDailyUsage()
    yield
    app.dependency_overrides.clear()


async def test_usage_anon_returns_balance(override_usage):
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.get("/v1/usage", headers={"X-Device-Id": "dev1"})
    assert resp.status_code == 200
    assert resp.json() == {"loggedIn": False, "balance": 1_500_000, "hasAccount": True}


async def test_usage_no_account_zero_balance(override_usage):
    app.dependency_overrides[get_credits] = lambda: FakeCredits(balance=0, has_account=False)
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.get("/v1/usage", headers={"X-Device-Id": "dev1"})
    assert resp.json() == {"loggedIn": False, "balance": 0, "hasAccount": False}


async def test_usage_logged_in_returns_tokens(override_usage):
    app.dependency_overrides[current_user_optional] = lambda: 5
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/v1/usage?localDate=2026-06-08", headers={"Authorization": "Bearer x"})
        assert resp.status_code == 200
        assert resp.json() == {
            "loggedIn": True,
            "balance": 1_500_000,
            "hasAccount": True,
            "tokensToday": 1234,
        }
    finally:
        app.dependency_overrides.pop(current_user_optional, None)


async def test_grant_gift_returns_2yuan():
    # 领赠送：发 ¥2（2,000,000 micro-¥）
    app.dependency_overrides[get_credits] = lambda: FakeCredits()
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            r = await c.post("/v1/grant/gift", headers={"X-Device-Id": "dev1"})
        assert r.json() == {"ok": True, "balance": 2_000_000}
    finally:
        app.dependency_overrides.clear()


async def test_grant_gift_missing_device_rejected():
    app.dependency_overrides[get_credits] = lambda: FakeCredits()
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            r = await c.post("/v1/grant/gift")
        assert r.json()["ok"] is False
    finally:
        app.dependency_overrides.clear()
