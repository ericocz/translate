import httpx
import pytest
from httpx import ASGITransport

from app.main import app
from app.routers.deps import current_user_optional
from app.routers.translate import get_anon_quota, get_daily_usage


class FakeQuota:
    async def usage(self, device_id, local_date):
        return 2, 3


class FakeDailyUsage:
    async def tokens_today(self, user_id, local_date):
        return 1234


@pytest.fixture
def override_usage():
    app.dependency_overrides[get_anon_quota] = lambda: FakeQuota()
    app.dependency_overrides[get_daily_usage] = lambda: FakeDailyUsage()
    yield
    app.dependency_overrides.clear()


async def test_usage_returns_used_and_remaining(override_usage):
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.get("/v1/usage?localDate=2026-06-08", headers={"X-Device-Id": "dev1"})
    assert resp.status_code == 200
    assert resp.json() == {"loggedIn": False, "used": 2, "limit": 3, "remaining": 1}


async def test_usage_logged_in_returns_tokens(override_usage):
    app.dependency_overrides[current_user_optional] = lambda: 5
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/v1/usage?localDate=2026-06-08", headers={"Authorization": "Bearer x"})
        assert resp.status_code == 200
        assert resp.json() == {"loggedIn": True, "tokensToday": 1234}
    finally:
        app.dependency_overrides.pop(current_user_optional, None)
