from typing import AsyncIterator

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from app.db.base import async_session
from app.services.redeem_repo import RedeemCodeRepo

router = APIRouter()


class RedeemVerifyIn(BaseModel):
    code: str


async def get_redeem_repo() -> AsyncIterator[RedeemCodeRepo]:
    async with async_session() as s:
        yield RedeemCodeRepo(s)


@router.post("/v1/redeem/verify")
async def redeem_verify(req: RedeemVerifyIn, request: Request, repo=Depends(get_redeem_repo)):
    """客户端填买断码激活：验码 + 绑当前设备（X-Device-Id）。
    成功 → {ok:true, product};失败 → {ok:false, reason}（missing_device / invalid_code / device_limit）。
    激活后客户端记买断态、解锁 BYOK——后续翻译走客户端直连，不再经本服务。"""
    device_id = request.headers.get("x-device-id", "")
    if not device_id:
        return {"ok": False, "reason": "missing_device"}
    result = await repo.verify(req.code.strip(), device_id)
    return {"ok": result.ok, "product": result.product, "reason": result.reason}
