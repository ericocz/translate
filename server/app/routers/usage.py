from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, Request

from app.routers.deps import current_user_optional
from app.routers.translate import get_credits, get_daily_usage
from app.services.credit_repo import (
    BUCKET_GIFT_CNY,
    BUCKET_RECHARGE_CNY,
    BUCKET_RECHARGE_USD,
    device_owner,
    user_owner,
)

router = APIRouter()

GIFT_AMOUNT = Decimal("2")  # 赠送额度 ¥2（元，进 gift_cny 桶）


@router.get("/v1/usage")
async def usage_endpoint(
    request: Request,
    localDate: str | None = None,
    credits=Depends(get_credits),
    daily=Depends(get_daily_usage),
    user_id: int | None = Depends(current_user_optional),
):
    """popup 用：返回额度三桶余额（owner = 登录 u:{id} 或设备 d:{deviceId}）+ 登录态。
    hasAccount=是否领过赠送/充过（前端据此决定是否显示「领取赠送」）。

    分桶展示（前端按需显示）：giftCny=赠送·人民币、cny=充值·人民币、usd=充值·美元；
    各桶 >0 才展示（赠送用光即不再显示「赠送余额」）。"""
    local_date = localDate or date.today().isoformat()
    device_id = request.headers.get("x-device-id", "")
    owner = user_owner(user_id) if user_id is not None else (device_owner(device_id) if device_id else None)
    bals = await credits.get_balances(owner) if owner else None
    has_account = await credits.has_account(owner) if owner else False
    out = {
        "loggedIn": user_id is not None,
        "hasAccount": has_account,
        # 三桶余额（桶币种原生单位；前端 round 2 位，>0 才展示对应余额）。
        "giftCny": float(bals[BUCKET_GIFT_CNY]) if bals else 0.0,
        "cny": float(bals[BUCKET_RECHARGE_CNY]) if bals else 0.0,
        "usd": float(bals[BUCKET_RECHARGE_USD]) if bals else 0.0,
    }
    if user_id is not None:
        out["tokensToday"] = await daily.tokens_today(user_id, local_date)
    return out


@router.post("/v1/grant/gift")
async def grant_gift(request: Request, credits=Depends(get_credits)):
    """领取赠送额度：发 ¥2，不需注册。额度发到 device owner（d:{deviceId}）。

    防薅：幂等键优先用 X-Instance-Id（chrome.instanceID——**清 storage 免疫、须卸载重装才变**，
    比客户端 deviceId 难重置），故「清缓存换 deviceId 反复领」会被同一 instanceID 的幂等键拦下。
    缺 instanceID 才回退 deviceId 幂等（旧客户端 / 取不到 instanceID 的兜底）。
    CreditTxn 的 idempotency_key 唯一约束保证只发一次（重复领返回当前余额）。"""
    device_id = request.headers.get("x-device-id", "")
    if not device_id:
        return {"ok": False, "error": "missing device id", "balance": 0}
    instance_id = request.headers.get("x-instance-id", "").strip()
    owner = device_owner(device_id)
    idem = f"gift:inst:{instance_id}" if instance_id else f"gift:{owner}"
    balance = await credits.grant(
        owner, GIFT_AMOUNT, kind="gift", bucket=BUCKET_GIFT_CNY, idempotency_key=idem
    )
    return {"ok": True, "balance": float(balance)}
