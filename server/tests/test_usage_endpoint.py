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
        self.granted_keys = []  # 收到的 idempotency_key（验防薅幂等键来源）
        self._used = set()  # 模拟真实幂等：同 key 只入账一次

    async def get_account(self, owner):
        return SimpleNamespace(owner=owner, balance_micro=self._balance) if self._has else None

    async def grant(self, owner, amount, kind="grant", idempotency_key=None):
        self.granted_keys.append(idempotency_key)
        if idempotency_key is not None and idempotency_key in self._used:
            return self._balance  # 已入账，幂等返回当前余额（不重复发）
        if idempotency_key is not None:
            self._used.add(idempotency_key)
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


async def test_gift_instance_id_idempotent_across_devices():
    """防薅核心：清 storage 换 deviceId 但 instanceID 不变 → 同幂等键被拦、不重复发。"""
    fake = FakeCredits()
    app.dependency_overrides[get_credits] = lambda: fake
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            r1 = await c.post(
                "/v1/grant/gift", headers={"X-Device-Id": "devA", "X-Instance-Id": "inst-X"}
            )
            r2 = await c.post(
                "/v1/grant/gift", headers={"X-Device-Id": "devB", "X-Instance-Id": "inst-X"}
            )
        assert r1.json()["balance"] == 2_000_000
        assert r2.json()["balance"] == 2_000_000  # 没再发（仍 ¥2，不是 ¥4）
        assert fake.granted_keys == ["gift:inst:inst-X", "gift:inst:inst-X"]
    finally:
        app.dependency_overrides.clear()


async def test_gift_new_instance_id_can_grant_again():
    """卸载重装 → instanceID 变 → 新幂等键、可再领（成本高于清 storage，门槛足够）。"""
    fake = FakeCredits()
    app.dependency_overrides[get_credits] = lambda: fake
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            await c.post("/v1/grant/gift", headers={"X-Device-Id": "devA", "X-Instance-Id": "inst-X"})
            r2 = await c.post(
                "/v1/grant/gift", headers={"X-Device-Id": "devC", "X-Instance-Id": "inst-Y"}
            )
        assert r2.json()["balance"] == 4_000_000  # 不同 instanceID 各发一次
        assert fake.granted_keys == ["gift:inst:inst-X", "gift:inst:inst-Y"]
    finally:
        app.dependency_overrides.clear()


async def test_gift_falls_back_to_device_without_instance_id():
    """无 X-Instance-Id（旧客户端 / 取不到）→ 回退 deviceId 幂等键。"""
    fake = FakeCredits()
    app.dependency_overrides[get_credits] = lambda: fake
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            await c.post("/v1/grant/gift", headers={"X-Device-Id": "devA"})
        assert fake.granted_keys == ["gift:d:devA"]
    finally:
        app.dependency_overrides.clear()
