import hashlib
import hmac

from app.services.creem import parse_checkout_completed, verify_signature

SECRET = "whsec_test_123"


def _sign(raw: bytes) -> str:
    return hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()


def test_verify_ok():
    raw = b'{"a":1}'
    assert verify_signature(raw, _sign(raw), SECRET) is True


def test_verify_tampered_body():
    raw = b'{"a":1}'
    assert verify_signature(b'{"a":2}', _sign(raw), SECRET) is False


def test_verify_empty_secret_or_sig():
    assert verify_signature(b"x", "deadbeef", "") is False
    assert verify_signature(b"x", "", SECRET) is False


def test_parse_paid_checkout():
    p = {
        "eventType": "checkout.completed",
        "object": {
            "order": {
                "id": "ord_1",
                "status": "paid",
                "amount": 999,
                "currency": "USD",
                "product": {"id": "prod_buyout"},
            },
            "customer": {"email": "u@x.com"},
        },
    }
    out = parse_checkout_completed(p)
    assert out == {
        "order_id": "ord_1",
        "email": "u@x.com",
        "product_id": "prod_buyout",
        "amount": 999,
        "currency": "USD",
    }


def test_parse_ignores_other_event():
    assert parse_checkout_completed({"eventType": "subscription.active"}) is None


def test_parse_ignores_unpaid():
    assert (
        parse_checkout_completed(
            {
                "eventType": "checkout.completed",
                "object": {"order": {"id": "o", "status": "pending"}, "customer": {"email": "a@b.c"}},
            }
        )
        is None
    )
