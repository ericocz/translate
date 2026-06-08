from datetime import date

from fastapi import APIRouter, Depends, Request

from app.routers.deps import current_user_optional
from app.routers.translate import get_anon_quota, get_daily_usage, get_tier

router = APIRouter()


@router.get("/v1/usage")
async def usage_endpoint(
    request: Request,
    localDate: str | None = None,
    quota=Depends(get_anon_quota),
    daily=Depends(get_daily_usage),
    tier=Depends(get_tier),
    user_id: int | None = Depends(current_user_optional),
):
    """popup 用：登录返回当日 token + 当前档位日上限 + 升降档提醒；匿名返回当日免费页数。"""
    local_date = localDate or date.today().isoformat()
    if user_id is not None:
        tokens = await daily.tokens_today(user_id, local_date)
        tev = await tier.evaluate(user_id, local_date)  # 也驱动跨日结算
        notice = await tier.pop_notice(user_id)
        return {"loggedIn": True, "tokensToday": tokens, "cap": tev.cap, "notice": notice}
    device_id = request.headers.get("x-device-id", "")
    used, limit = await quota.usage(device_id, local_date)
    return {"loggedIn": False, "used": used, "limit": limit, "remaining": max(0, limit - used)}
