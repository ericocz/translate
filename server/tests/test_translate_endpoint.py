import base64
import json

import httpx
import pytest
from httpx import ASGITransport
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core import crypto
from app.main import app
from app.routers.deps import current_user_optional
from app.routers.translate import (
    get_anon_quota,
    get_daily_usage,
    get_deepseek_stream,
    get_tier,
)
from app.services.quota import QuotaDecision


async def fake_stream(api_key, blocks):
    for bid, _src in blocks:
        yield f"[[{bid}]] 你好"


class FakeQuotaAllow:
    async def check_and_count(self, *a, **k):
        return QuotaDecision(True, 1, 3)


class FakeQuotaDeny:
    async def check_and_count(self, *a, **k):
        return QuotaDecision(False, 3, 3, "今日免费 3 页已用完，登录后免费畅用")


class FakeDaily:
    def __init__(self):
        self.added: list[tuple[int, int, int, int]] = []

    async def add(self, user_id, local_date, input_tokens, output_tokens, pages=0):
        self.added.append((user_id, input_tokens, output_tokens, pages))

    async def tokens_today(self, user_id, local_date):
        return sum(i + o for _, i, o, _ in self.added)


class _Tev:
    def __init__(self, allowed, notice, cap):
        self.allowed, self.notice, self.cap = allowed, notice, cap


class FakeTierAllow:
    async def evaluate(self, user_id, local_date):
        return _Tev(True, None, 200_000)


class FakeTierBlock:
    async def evaluate(self, user_id, local_date):
        return _Tev(False, "今日额度已达上限（疑似异常用量），明日恢复", 10_000)


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
    app.dependency_overrides[get_deepseek_stream] = lambda: fake_stream
    app.dependency_overrides[get_anon_quota] = lambda: FakeQuotaAllow()
    app.dependency_overrides[get_daily_usage] = lambda: FakeDaily()
    app.dependency_overrides[get_tier] = lambda: FakeTierAllow()
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


async def test_logged_in_skips_quota(override):
    # 即使配额仓库会拒绝，登录用户（current_user_optional 返回 user_id）也照常翻译
    app.dependency_overrides[get_anon_quota] = lambda: FakeQuotaDeny()
    app.dependency_overrides[current_user_optional] = lambda: 1
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post(
                "/v1/translate",
                json={"blocks": [{"id": "b1", "source": "Hi"}], "pageKey": "p1"},
                headers={"X-Device-Id": "dev1", "Authorization": "Bearer x"},
            )
        kinds = [e for e, _ in parse_sse(resp.text)]
        assert "block" in kinds and "done" in kinds and "quota" not in kinds
    finally:
        app.dependency_overrides.pop(current_user_optional, None)


async def test_logged_in_records_daily_usage(override):
    fake_daily = FakeDaily()
    app.dependency_overrides[get_daily_usage] = lambda: fake_daily
    app.dependency_overrides[current_user_optional] = lambda: 7
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post(
                "/v1/translate",
                json={"blocks": [{"id": "b1", "source": "Hi"}], "pageKey": "p1"},
                headers={"X-Device-Id": "dev1", "Authorization": "Bearer x"},
            )
        assert resp.status_code == 200
        assert fake_daily.added and fake_daily.added[0][0] == 7
        assert fake_daily.added[0][1] + fake_daily.added[0][2] > 0  # 记了 token
    finally:
        app.dependency_overrides.pop(get_daily_usage, None)
        app.dependency_overrides.pop(current_user_optional, None)


def _enc_client():
    """模拟加密客户端：返回 (服务端私钥, 客户端临时公钥 b64, 双方共享 AES 密钥)。"""
    server_priv = crypto.load_private_key(crypto.gen_private_key_b64())
    eph = ec.generate_private_key(ec.SECP256R1())
    eph_pub_b64 = base64.b64encode(
        eph.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
    ).decode()
    server_pub = ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256R1(), base64.b64decode(crypto.public_key_b64(server_priv))
    )
    key = HKDF(
        algorithm=hashes.SHA256(), length=32, salt=b"imt-d13", info=b"session-key"
    ).derive(eph.exchange(ec.ECDH(), server_pub))
    return server_priv, eph_pub_b64, key


async def test_translate_encrypted_path(override, monkeypatch):
    # 带 X-Eph-Pub：原文以 ct 发、译文以 ct 回，且能用同一密钥解出明文译文。
    server_priv, eph_pub_b64, key = _enc_client()
    monkeypatch.setattr("app.routers.translate._server_priv", server_priv)
    ct_in = crypto.encrypt(key, "Hi", "src:b1")
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.post(
            "/v1/translate",
            json={"blocks": [{"id": "b1", "ct": ct_in}]},
            headers={"X-Eph-Pub": eph_pub_b64},
        )
    assert resp.status_code == 200
    blocks = [json.loads(d) for e, d in parse_sse(resp.text) if e == "block"]
    assert len(blocks) == 1 and "translated" not in blocks[0]  # 密文路径不回明文
    assert crypto.decrypt(key, blocks[0]["ct"], "dst:b1") == "你好"


async def test_logged_in_over_cap_blocks(override):
    # 登录用户超日上限：发 quota 提醒、不翻译
    app.dependency_overrides[get_tier] = lambda: FakeTierBlock()
    app.dependency_overrides[current_user_optional] = lambda: 9
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post(
                "/v1/translate",
                json={"blocks": [{"id": "b1", "source": "Hi"}], "pageKey": "p1"},
                headers={"X-Device-Id": "dev1", "Authorization": "Bearer x"},
            )
        kinds = [e for e, _ in parse_sse(resp.text)]
        assert "quota" in kinds and "block" not in kinds and "done" not in kinds
    finally:
        app.dependency_overrides.pop(get_tier, None)
        app.dependency_overrides.pop(current_user_optional, None)
