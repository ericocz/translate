import json
import logging
from decimal import Decimal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select

from app.core.config import settings
from app.db.base import async_session
from app.db.models import User
from app.services import creem
from app.services.credit_repo import BUCKET_RECHARGE_USD, CreditRepo, user_owner

router = APIRouter()
log = logging.getLogger("billing")


@router.post("/v1/billing/creem/webhook")
async def creem_webhook(request: Request):
    """海外充值收单（Creem，$9.9 充值美元额度）：验签 → 解析 checkout.completed →
    凭付款邮箱匹配注册用户 → 幂等入账美元桶（recharge_usd）。

    充值须注册（余额跨设备/找回），故用付款邮箱关联账户——用户须用注册邮箱付款，
    邮箱不符则无法自动到账（落 warning，客服可手动补 admin/credits/grant）。"""
    raw = await request.body()
    sig = request.headers.get("creem-signature", "")
    if not creem.verify_signature(raw, sig, settings.creem_webhook_secret):
        return JSONResponse(status_code=400, content={"error": "bad signature"})
    try:
        payload = json.loads(raw)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "bad json"})

    parsed = creem.parse_checkout_completed(payload)
    if not parsed:
        return {"ok": True, "ignored": True}  # 非充值完成事件，幂等忽略、回 200 防重投
    if settings.creem_recharge_product_id and parsed["product_id"] != settings.creem_recharge_product_id:
        return {"ok": True, "ignored": True}  # 非充值商品

    usd = creem.usd_amount(parsed)  # 实付美元（cents→$），缺失时退化为配置档位
    email = parsed["email"].strip().lower()
    async with async_session() as s:
        user = await s.scalar(select(User).where(User.email == email))
        if user is None:
            log.warning("Creem 充值邮箱未匹配注册用户：email=%s order=%s", email, parsed["order_id"])
            return {"ok": True, "unmatched": True}  # 回 200 防重投；待客服手动补
        await CreditRepo(s).grant(
            user_owner(user.id),
            usd,
            kind="grant",
            bucket=BUCKET_RECHARGE_USD,
            idempotency_key=f"creem:{parsed['order_id']}",  # 重投/并发只入账一次
        )
    return {"ok": True, "credited_usd": float(usd)}
