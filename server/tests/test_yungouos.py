import hashlib

import httpx
import pytest

from app.services import yungouos
from app.services.yungouos import (
    YunGouOSError,
    check_notify_sign,
    create_native_pay,
    pay_sign,
)


def test_pay_sign_follows_rule():
    """字典序升序 → k=v&...&key={key} → MD5 大写。用独立拼接复算验拼接规则。"""
    params = {"out_trade_no": "o1", "total_fee": "10.00", "mch_id": "m1", "body": "充值"}
    key = "secret-key"
    # 期望：按 key 字典序 body < mch_id < out_trade_no < total_fee
    expected_str = "body=充值&mch_id=m1&out_trade_no=o1&total_fee=10.00&key=secret-key"
    expected = hashlib.md5(expected_str.encode()).hexdigest().upper()
    assert pay_sign(params, key) == expected
    assert pay_sign(params, key).isupper()


def test_check_notify_sign_ok_and_bad():
    key = "k"
    payload = {
        "code": "1",
        "orderNo": "n1",
        "outTradeNo": "o1",
        "payNo": "p1",
        "money": "10.00",
        "mchId": "m1",
        "attach": "u:5",  # 不参与验签字段
    }
    good = pay_sign(
        {k: str(payload[k]) for k in ("code", "orderNo", "outTradeNo", "payNo", "money", "mchId")},
        key,
    )
    assert check_notify_sign(payload, good, key) is True
    assert check_notify_sign(payload, "DEADBEEF", key) is False


async def test_create_native_pay_signs_four_fields_and_returns_qr(monkeypatch):
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        captured["form"] = dict(httpx.QueryParams(req.content.decode()))
        return httpx.Response(200, json={"code": "0", "data": "https://qr.example/abc.png"})

    real = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real(transport=transport))

    qr = await create_native_pay(
        out_trade_no="rc-5-abcd",
        total_fee="10.00",
        mch_id="m1",
        body="秒懂翻译额度充值",
        pay_key="k",
        notify_url="https://b/v1/recharge/notify",
        attach="u:5",
    )
    assert qr == "https://qr.example/abc.png"
    form = captured["form"]
    # 签名只覆盖 4 个核心字段
    expected_sign = pay_sign(
        {"out_trade_no": "rc-5-abcd", "total_fee": "10.00", "mch_id": "m1", "body": "秒懂翻译额度充值"},
        "k",
    )
    assert form["sign"] == expected_sign
    assert form["notify_url"] == "https://b/v1/recharge/notify"
    assert form["attach"] == "u:5"
    assert form["type"] == "2"


async def test_create_native_pay_raises_on_error_code(monkeypatch):
    real = httpx.AsyncClient
    transport = httpx.MockTransport(
        lambda req: httpx.Response(200, json={"code": "-1", "msg": "商户号不存在"})
    )
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real(transport=transport))
    with pytest.raises(YunGouOSError):
        await create_native_pay(
            out_trade_no="o", total_fee="10.00", mch_id="m", body="b",
            pay_key="k", notify_url="https://b/n",
        )
