import json

import httpx
import pytest
from httpx import ASGITransport

from app.main import app
from app.routers.translate import get_anon_quota, get_cache, get_deepseek_stream
from app.services.quota import QuotaDecision


class FakeCache:
    def __init__(self):
        self.store, self.saved = {}, []

    async def get_many(self, sources):
        return {s: self.store[s] for s in sources if s in self.store}

    async def set_many(self, entries):
        self.saved.extend(entries)


async def fake_stream(api_key, blocks):
    for bid, _src in blocks:
        yield f"[[{bid}]] 你好"


class FakeQuotaAllow:
    async def check_and_count(self, *a, **k):
        return QuotaDecision(True, 1, 3)


class FakeQuotaDeny:
    async def check_and_count(self, *a, **k):
        return QuotaDecision(False, 3, 3, "今日免费 3 页已用完，登录后免费畅用")


def parse_sse(text: str) -> list[tuple[str, str]]:
    events: list[tuple[str, str]] = []
    cur = None
    for line in text.splitlines():
        if line.startswith("event:"):
            cur = line[len("event:"):].strip()
        elif line.startswith("data:"):
            events.append((cur, line[len("data:"):].strip()))
    return events


@pytest.fixture
def override():
    app.dependency_overrides[get_cache] = lambda: FakeCache()
    app.dependency_overrides[get_deepseek_stream] = lambda: fake_stream
    app.dependency_overrides[get_anon_quota] = lambda: FakeQuotaAllow()
    yield
    app.dependency_overrides.clear()


async def test_translate_streams_block_then_done(override):
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.post("/v1/translate", json={"blocks": [{"id": "b1", "source": "Hi"}]})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    evs = parse_sse(resp.text)
    blocks = [json.loads(d) for e, d in evs if e == "block"]
    assert {"id": "b1", "translated": "你好"} in blocks
    assert any(e == "done" for e, _ in evs)


async def test_translate_blocked_emits_quota(override):
    # 额度耗尽：发 pageKey + deviceId 触发闸门，FakeQuotaDeny 拒绝
    app.dependency_overrides[get_anon_quota] = lambda: FakeQuotaDeny()
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.post(
            "/v1/translate",
            json={"blocks": [{"id": "b1", "source": "Hi"}], "pageKey": "p1"},
            headers={"X-Device-Id": "dev1"},
        )
    evs = parse_sse(resp.text)
    kinds = [e for e, _ in evs]
    assert "quota" in kinds
    assert "block" not in kinds and "done" not in kinds  # 拒绝即不译
