import hashlib
import hmac
import json
from decimal import Decimal

import httpx
import pytest
from httpx import ASGITransport

from app.core.config import settings
from app.db.base import async_session
from app.services.auth import AuthService
from app.services.credit_repo import BUCKET_RECHARGE_USD, CreditRepo, user_owner
from app.main import app

SECRET = "whsec_test"
EMAIL = "u@x.com"


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setattr(settings, "creem_webhook_secret", SECRET)
    monkeypatch.setattr(settings, "creem_recharge_product_id", "")  # 联调不校验商品


async def _make_user(email=EMAIL) -> int:
    async with async_session() as s:
        res = await AuthService(s).register(email, "pw1234")
        return res.user_id


def _body(order_id="ord_1", email=EMAIL, amount=990) -> bytes:
    return json.dumps(
        {
            "eventType": "checkout.completed",
            "object": {
                "order": {
                    "id": order_id,
                    "status": "paid",
                    "amount": amount,
                    "currency": "USD",
                    "product": {"id": "prod_recharge"},
                },
                "customer": {"email": email},
            },
        }
    ).encode()


def _sig(raw: bytes) -> str:
    return hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()


async def _post(raw: bytes, sig: str) -> httpx.Response:
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        return await c.post(
            "/v1/billing/creem/webhook",
            content=raw,
            headers={"creem-signature": sig, "content-type": "application/json"},
        )


async def _usd_balance(user_id: int) -> Decimal:
    async with async_session() as s:
        return await CreditRepo(s).get_balance(user_owner(user_id), BUCKET_RECHARGE_USD)


async def test_paid_credits_usd_bucket(db_session):
    uid = await _make_user()
    raw = _body(amount=990)  # 990 cents = $9.9
    r = await _post(raw, _sig(raw))
    assert r.status_code == 200 and r.json()["credited_usd"] == 9.9
    assert await _usd_balance(uid) == Decimal("9.90")


async def test_replay_same_order_idempotent(db_session):
    uid = await _make_user()
    raw = _body()
    await _post(raw, _sig(raw))
    await _post(raw, _sig(raw))  # 重投
    assert await _usd_balance(uid) == Decimal("9.90")  # 仍只入账一次


async def test_unmatched_email_not_credited(db_session):
    uid = await _make_user(email="real@x.com")
    raw = _body(email="someone-else@x.com")  # 付款邮箱非注册邮箱
    r = await _post(raw, _sig(raw))
    assert r.status_code == 200 and r.json().get("unmatched")
    assert await _usd_balance(uid) == Decimal("0")


async def test_bad_signature_rejected(db_session):
    await _make_user()
    raw = _body()
    r = await _post(raw, "deadbeef")
    assert r.status_code == 400


async def test_other_event_ignored(db_session):
    raw = json.dumps({"eventType": "subscription.active"}).encode()
    r = await _post(raw, _sig(raw))
    assert r.status_code == 200 and r.json().get("ignored")
