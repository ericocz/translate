import httpx
from httpx import ASGITransport

from app.db.base import async_session
from app.main import app
from app.services.redeem_repo import RedeemCodeRepo


async def _issue(s, source_ref="order-x", max_devices=2):
    return await RedeemCodeRepo(s).issue(
        email="b@x.com", source="creem", source_ref=source_ref, max_devices=max_devices
    )


async def test_verify_activates_and_binds(db_session):
    async with async_session() as s:
        rc = await _issue(s)
    async with async_session() as s:
        res = await RedeemCodeRepo(s).verify(rc.code, "dev1")
    assert res.ok is True and res.product == "buyout"


async def test_verify_idempotent_same_device(db_session):
    async with async_session() as s:
        rc = await _issue(s)
    async with async_session() as s:
        r1 = await RedeemCodeRepo(s).verify(rc.code, "dev1")
    async with async_session() as s:
        r2 = await RedeemCodeRepo(s).verify(rc.code, "dev1")  # 同设备重复激活
    assert r1.ok and r2.ok


async def test_verify_device_limit(db_session):
    async with async_session() as s:
        rc = await _issue(s, max_devices=2)
    for dev in ("d1", "d2"):
        async with async_session() as s:
            assert (await RedeemCodeRepo(s).verify(rc.code, dev)).ok is True
    async with async_session() as s:
        res = await RedeemCodeRepo(s).verify(rc.code, "d3")  # 第 3 台超限
    assert res.ok is False and res.reason == "device_limit"


async def test_verify_invalid_code(db_session):
    async with async_session() as s:
        res = await RedeemCodeRepo(s).verify("IMT-XXXX-YYYY-ZZZZ", "dev1")
    assert res.ok is False and res.reason == "invalid_code"


async def test_verify_endpoint_ok(db_session):
    async with async_session() as s:
        rc = await _issue(s, source_ref="order-ep")
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.post(
            "/v1/redeem/verify", json={"code": rc.code}, headers={"X-Device-Id": "dev1"}
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True and body["product"] == "buyout"


async def test_verify_endpoint_missing_device(db_session):
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.post("/v1/redeem/verify", json={"code": "whatever"})
    assert resp.json()["ok"] is False and resp.json()["reason"] == "missing_device"
