from datetime import date

from fastapi import APIRouter, Depends, Request

from app.routers.deps import current_user_optional
from app.routers.translate import get_credits, get_daily_usage
from app.services.credit_repo import device_owner, user_owner

router = APIRouter()

GIFT_AMOUNT_MICRO = 2_000_000  # 赠送额度 ¥2（micro-¥）


@router.get("/v1/usage")
async def usage_endpoint(
    request: Request,
    localDate: str | None = None,
    credits=Depends(get_credits),
    daily=Depends(get_daily_usage),
    user_id: int | None = Depends(current_user_optional),
):
    """popup 用：返回额度账户余额（owner = 登录 u:{id} 或设备 d:{deviceId}）+ 登录态。
    hasAccount=是否领过赠送/充过（前端据此决定是否显示「领取赠送」）。"""
    local_date = localDate or date.today().isoformat()
    device_id = request.headers.get("x-device-id", "")
    owner = user_owner(user_id) if user_id is not None else (device_owner(device_id) if device_id else None)
    account = await credits.get_account(owner) if owner else None
    out = {
        "loggedIn": user_id is not None,
        "balance": int(account.balance_micro) if account else 0,  # micro-¥
        "hasAccount": account is not None,
    }
    if user_id is not None:
        out["tokensToday"] = await daily.tokens_today(user_id, local_date)
    return out


@router.post("/v1/grant/gift")
async def grant_gift(request: Request, credits=Depends(get_credits)):
    """领取赠送额度：按 deviceId 幂等发 ¥2（一设备一次，不需注册）。
    幂等：idempotency_key=gift:d:{deviceId}，CreditTxn 唯一约束保证只发一次（重复领返回当前余额）。
    指纹加固（instanceID + 服务端指纹双保险）留后续细化切片。"""
    device_id = request.headers.get("x-device-id", "")
    if not device_id:
        return {"ok": False, "error": "missing device id", "balance": 0}
    owner = device_owner(device_id)
    balance = await credits.grant(
        owner, GIFT_AMOUNT_MICRO, kind="gift", idempotency_key=f"gift:{owner}"
    )
    return {"ok": True, "balance": balance}
