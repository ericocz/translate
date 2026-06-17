import json
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.db.base import async_session
from app.services import creem
from app.services.email import make_email_sender
from app.services.redeem_repo import RedeemCodeRepo

router = APIRouter()
log = logging.getLogger("billing")
_email = make_email_sender()


@router.post("/v1/billing/creem/webhook")
async def creem_webhook(request: Request):
    """D-18 海外买断收单：验签 → 解析 checkout.completed → 幂等签发注册码 → 发邮件。"""
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
        return {"ok": True, "ignored": True}  # 非买断完成事件，幂等忽略、回 200 防重投
    if settings.creem_buyout_product_id and parsed["product_id"] != settings.creem_buyout_product_id:
        return {"ok": True, "ignored": True}  # 非买断商品

    async with async_session() as s:
        rc = await RedeemCodeRepo(s).issue(
            email=parsed["email"], source="creem", source_ref=parsed["order_id"]
        )
    # 邮件失败不丢单：码已落库，可重投 webhook / admin 手动补发。
    try:
        await _email.send(
            parsed["email"],
            "你的秒懂翻译买断注册码",
            f"感谢购买！注册码：{rc.code}（最多 {rc.max_devices} 台设备激活）。",
        )
    except Exception:
        log.exception("买断码邮件发送失败（码已落库 order=%s，可重投/手动补发）", parsed["order_id"])
    return {"ok": True, "code_issued": True}
