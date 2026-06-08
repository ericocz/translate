from datetime import date

from fastapi import APIRouter, Depends, Request

from app.routers.translate import get_anon_quota

router = APIRouter()


@router.get("/v1/usage")
async def usage_endpoint(
    request: Request, localDate: str | None = None, quota=Depends(get_anon_quota)
):
    """popup 用：当前设备当日免费用量。P2 恒为匿名；P3 起 loggedIn 反映登录态。"""
    device_id = request.headers.get("x-device-id", "")
    local_date = localDate or date.today().isoformat()
    used, limit = await quota.usage(device_id, local_date)
    return {"loggedIn": False, "used": used, "limit": limit, "remaining": max(0, limit - used)}
