import logging
import uuid
from urllib.parse import parse_qsl

from fastapi import APIRouter, Depends, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from app.core.config import settings
from app.db.base import async_session
from app.routers.deps import current_user_optional
from app.services import yungouos
from app.services.credit_repo import CreditRepo, user_owner

router = APIRouter()
log = logging.getLogger("recharge")

# 充值档位（元）→ credits 按 1:1 入账（micro-¥）。平台盈利在翻译 ×1.3、不在充值加价。
TIERS = {"10": 10, "30": 30, "68": 68}
PRODUCT_BODY = "秒懂翻译额度充值"


def _configured() -> bool:
    return bool(settings.yungouos_mch_id and settings.yungouos_pay_key and settings.public_base_url)


def _parse_user_id(out_trade_no: str) -> int | None:
    """out_trade_no = rc-{user_id}-{nonce}；解析回 user_id（在验签字段内、可信）。"""
    parts = out_trade_no.split("-")
    if len(parts) >= 3 and parts[0] == "rc":
        try:
            return int(parts[1])
        except ValueError:
            return None
    return None


class RechargeCreateIn(BaseModel):
    tier: str


@router.post("/v1/recharge/create")
async def recharge_create(
    req: RechargeCreateIn, user_id: int | None = Depends(current_user_optional)
):
    """登录用户充值：选档位 → YunGouOS 微信扫码下单 → 返回付款二维码地址 + 订单号。
    充值须注册（余额跨设备 / 找回），故未登录拒绝。"""
    if user_id is None:
        return {"ok": False, "error": "login_required"}
    if req.tier not in TIERS:
        return {"ok": False, "error": "bad_tier"}
    if not _configured():
        return {"ok": False, "error": "unconfigured"}
    yuan = TIERS[req.tier]
    # 订单号编码 user_id（落在 notify 验签字段 outTradeNo 内 → 可信关联到账户）。
    out_trade_no = f"rc-{user_id}-{uuid.uuid4().hex[:12]}"
    try:
        qr = await yungouos.create_native_pay(
            out_trade_no=out_trade_no,
            total_fee=f"{yuan:.2f}",
            mch_id=settings.yungouos_mch_id,
            body=PRODUCT_BODY,
            pay_key=settings.yungouos_pay_key,
            notify_url=f"{settings.public_base_url}/v1/recharge/notify",
            attach=user_owner(user_id),
        )
    except Exception:
        log.exception("YunGouOS 下单失败 user=%s tier=%s", user_id, req.tier)
        return {"ok": False, "error": "create_failed"}
    return {"ok": True, "qr": qr, "outTradeNo": out_trade_no, "yuan": yuan}


@router.post("/v1/recharge/notify")
async def recharge_notify(request: Request):
    """YunGouOS 异步回调：验签 → 解析 user_id → 幂等 grant credits。回 SUCCESS（否则 YunGouOS 重投）。"""
    # YunGouOS notify 是 x-www-form-urlencoded；手动解析 raw body 避免引入 python-multipart 依赖。
    form = dict(parse_qsl((await request.body()).decode("utf-8")))
    sign = form.get("sign", "")
    if not yungouos.check_notify_sign(form, sign, settings.yungouos_pay_key):
        return PlainTextResponse("FAIL", status_code=400)
    # YunGouOS 支付成功回调 code=1；非成功状态幂等忽略、仍回 SUCCESS 防重投。
    if form.get("code") != "1":
        return PlainTextResponse("SUCCESS")
    out_trade_no = form.get("outTradeNo", "")
    user_id = _parse_user_id(out_trade_no)
    if user_id is None:
        log.warning("充值回调无法解析 user_id：outTradeNo=%s", out_trade_no)
        return PlainTextResponse("SUCCESS")
    micro = int(round(float(form.get("money", "0")) * 1_000_000))
    async with async_session() as s:
        await CreditRepo(s).grant(
            user_owner(user_id),
            micro,
            kind="grant",
            idempotency_key=f"recharge:{out_trade_no}",  # 重投/并发只入账一次
        )
    return PlainTextResponse("SUCCESS")
