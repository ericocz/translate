from decimal import Decimal

import httpx
from httpx import ASGITransport

from app.core.config import settings
from app.db.base import async_session
from app.main import app
from app.routers.deps import current_user_optional
from app.services import yungouos
from app.services.credit_repo import CreditRepo, user_owner

SIGN_FIELDS = ("code", "orderNo", "outTradeNo", "payNo", "money", "mchId")


def _signed_notify(user_id=5, money="10.00", code="1", oid=None, key="k"):
    oid = oid or f"rc-{user_id}-abc123"
    payload = {
        "code": code,
        "orderNo": "n1",
        "outTradeNo": oid,
        "payNo": "p1",
        "money": money,
        "mchId": "m1",
    }
    payload["sign"] = yungouos.pay_sign({k: payload[k] for k in SIGN_FIELDS}, key)
    return payload


# —— create ——
async def test_create_requires_login():
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post("/v1/recharge/create", json={"tier": "10"})
    assert r.json() == {"ok": False, "error": "login_required"}


async def test_create_bad_tier():
    app.dependency_overrides[current_user_optional] = lambda: 5
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            r = await c.post("/v1/recharge/create", json={"tier": "999"})
        assert r.json()["error"] == "bad_tier"
    finally:
        app.dependency_overrides.clear()


async def test_create_unconfigured(monkeypatch):
    app.dependency_overrides[current_user_optional] = lambda: 5
    monkeypatch.setattr(settings, "yungouos_mch_id", "")
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            r = await c.post("/v1/recharge/create", json={"tier": "10"})
        assert r.json()["error"] == "unconfigured"
    finally:
        app.dependency_overrides.clear()


async def test_create_success_returns_qr(monkeypatch):
    app.dependency_overrides[current_user_optional] = lambda: 5
    monkeypatch.setattr(settings, "yungouos_mch_id", "m1")
    monkeypatch.setattr(settings, "yungouos_pay_key", "k")
    monkeypatch.setattr(settings, "public_base_url", "https://b")
    captured = {}

    async def fake_create(**kw):
        captured.update(kw)
        return "https://qr/abc.png"

    monkeypatch.setattr(yungouos, "create_native_pay", fake_create)
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            r = await c.post("/v1/recharge/create", json={"tier": "10"})
        body = r.json()
        assert body["ok"] and body["qr"] == "https://qr/abc.png" and body["yuan"] == 10
        assert body["outTradeNo"].startswith("rc-5-")
        assert captured["total_fee"] == "10.00"
        assert captured["notify_url"] == "https://b/v1/recharge/notify"
        assert captured["attach"] == "u:5"
    finally:
        app.dependency_overrides.clear()


# —— notify ——
async def test_notify_grants_credits(db_session, monkeypatch):
    monkeypatch.setattr(settings, "yungouos_pay_key", "k")
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post("/v1/recharge/notify", data=_signed_notify())
    assert r.status_code == 200 and r.text == "SUCCESS"
    async with async_session() as s:
        bal = await CreditRepo(s).get_balance(user_owner(5))
    assert bal == Decimal("10")


async def test_notify_idempotent_on_replay(db_session, monkeypatch):
    monkeypatch.setattr(settings, "yungouos_pay_key", "k")
    form = _signed_notify(oid="rc-5-same")
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        await c.post("/v1/recharge/notify", data=form)
        await c.post("/v1/recharge/notify", data=form)  # 重投
    async with async_session() as s:
        bal = await CreditRepo(s).get_balance(user_owner(5))
    assert bal == Decimal("10")  # 仍只入账一次


async def test_notify_bad_signature_rejected(db_session, monkeypatch):
    monkeypatch.setattr(settings, "yungouos_pay_key", "k")
    form = _signed_notify()
    form["sign"] = "DEADBEEF"
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post("/v1/recharge/notify", data=form)
    assert r.status_code == 400
    async with async_session() as s:
        bal = await CreditRepo(s).get_balance(user_owner(5))
    assert bal == 0


async def test_notify_non_paid_code_ignored(db_session, monkeypatch):
    monkeypatch.setattr(settings, "yungouos_pay_key", "k")
    form = _signed_notify(code="0")  # 非支付成功
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post("/v1/recharge/notify", data=form)
    assert r.status_code == 200 and r.text == "SUCCESS"
    async with async_session() as s:
        bal = await CreditRepo(s).get_balance(user_owner(5))
    assert bal == 0  # 未入账
