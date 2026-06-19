import hashlib
import hmac
from decimal import Decimal
from typing import Any

# 充值固定档位（美元）——Creem 仅一个选项 $9.9。webhook 缺/坏 amount 时退化为此值。
DEFAULT_RECHARGE_USD = Decimal("9.9")


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


def usd_amount(parsed: dict[str, Any]) -> Decimal:
    """从 parse_checkout_completed 结果取实付美元（Creem amount 单位为分 → /100）。
    缺失/非美元/解析失败时退化为固定档位 $9.9（仅一个充值选项，不会误差太大）。"""
    amount = parsed.get("amount")
    currency = (parsed.get("currency") or "").lower()
    if amount is None or currency not in ("usd", ""):
        return DEFAULT_RECHARGE_USD
    try:
        return (Decimal(str(amount)) / 100).quantize(Decimal("0.01"))
    except (ArithmeticError, ValueError):
        return DEFAULT_RECHARGE_USD
