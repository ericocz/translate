import hashlib
import hmac
from typing import Any


def verify_signature(raw_body: bytes, signature: str, secret: str) -> bool:
    """Creem: creem-signature 头 = HMAC_SHA256(raw_body, secret) 的 hex。常量时间比较。"""
    if not secret or not signature:
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def parse_checkout_completed(payload: dict[str, Any]) -> dict[str, Any] | None:
    """仅认 eventType==checkout.completed 且订单已付。
    返回 {order_id, email, product_id, amount, currency}，否则 None。"""
    if payload.get("eventType") != "checkout.completed":
        return None
    obj = payload.get("object") or {}
    order = obj.get("order") or {}
    customer = obj.get("customer") or order.get("customer") or {}
    status = (order.get("status") or obj.get("status") or "").lower()
    if status not in ("paid", "completed"):
        return None
    order_id = str(order.get("id") or obj.get("id") or "")
    email = (customer.get("email") if isinstance(customer, dict) else "") or obj.get("customer_email") or ""
    product = order.get("product") or obj.get("product") or {}
    product_id = str(product.get("id") if isinstance(product, dict) else product or "")
    if not order_id or not email:
        return None
    return {
        "order_id": order_id,
        "email": email,
        "product_id": product_id,
        "amount": order.get("amount"),
        "currency": order.get("currency"),
    }
