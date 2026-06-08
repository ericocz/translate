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
    assert resp.json() == {"loggedIn": False, "used": 2, "limit": 3, "remaining": 1}
