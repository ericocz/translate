from datetime import date

from fastapi import APIRouter, Depends, Request

from app.routers.deps import current_user_optional
from app.routers.translate import get_anon_quota

router = APIRouter()


@router.get("/v1/usage")
async def usage_endpoint(
    request: Request,
    localDate: str | None = None,
    quota=Depends(get_anon_quota),
    user_id: int | None = Depends(current_user_optional),
):
    """popup 用：登录则无限；匿名返回当日免费用量。"""
    if user_id is not None:
        return {"loggedIn": True, "used": 0, "limit": None, "remaining": None}
    device_id = request.headers.get("x-device-id", "")
    local_date = localDate or date.today().isoformat()
    used, limit = await quota.usage(device_id, local_date)
    return {"loggedIn": False, "used": used, "limit": limit, "remaining": max(0, limit - used)}
