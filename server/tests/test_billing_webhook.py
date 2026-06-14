import hashlib
import hmac
import json

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import func, select

from app.core.config import settings
from app.db.base import async_session
from app.db.models import RedeemCode
from app.main import app

SECRET = "whsec_test"


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setattr(settings, "creem_webhook_secret", SECRET)
    monkeypatch.setattr(settings, "creem_buyout_product_id", "")  # 联调不校验商品


def _body(order_id="ord_1", email="u@x.com") -> bytes:
    return json.dumps(
        {
            "eventType": "checkout.completed",
            "object": {
                "order": {
                    "id": order_id,
                    "status": "paid",
                    "amount": 999,
                    "currency": "USD",
                    "product": {"id": "prod_buyout"},
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


async def test_paid_issues_code(db_session):
    raw = _body()
    r = await _post(raw, _sig(raw))
    assert r.status_code == 200 and r.json()["code_issued"]
    async with async_session() as s:
        n = await s.scalar(
            select(func.count()).select_from(RedeemCode).where(RedeemCode.source_ref == "ord_1")
        )
    assert n == 1


async def test_replay_same_order_idempotent(db_session):
    raw = _body()
    await _post(raw, _sig(raw))
    await _post(raw, _sig(raw))  # 重投
    async with async_session() as s:
        n = await s.scalar(
            select(func.count()).select_from(RedeemCode).where(RedeemCode.source_ref == "ord_1")
        )
    assert n == 1  # 仍只一张


async def test_bad_signature_rejected(db_session):
    raw = _body()
    r = await _post(raw, "deadbeef")
    assert r.status_code == 400
    async with async_session() as s:
        n = await s.scalar(select(func.count()).select_from(RedeemCode))
    assert n == 0


async def test_other_event_ignored(db_session):
    raw = json.dumps({"eventType": "subscription.active"}).encode()
    r = await _post(raw, _sig(raw))
    assert r.status_code == 200 and r.json().get("ignored")
    async with async_session() as s:
        n = await s.scalar(select(func.count()).select_from(RedeemCode))
    assert n == 0
