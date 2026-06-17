import json
from datetime import date
from typing import AsyncIterator

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core import crypto
from app.core.config import settings
from app.db.base import async_session
from app.services import deepseek
from app.routers.deps import current_user_optional
from app.services.translator import (
    BlockEvent,
    DoneEvent,
    ErrorEvent,
    SourceBlock,
    UsageEvent,
    translate,
)
from app.services.usage_repo import DailyUsageRepo
from app.services.credit_repo import CreditRepo, device_owner, user_owner
from app.services.pricing import cost

router = APIRouter()

# D-13 应用层加密：静态私钥启动时载一次；空＝明文路径（dev / 现有测试）。
_server_priv = crypto.load_private_key(settings.session_private_key) if settings.session_private_key else None

# 余额不足（无账户或余额≤0）统一文案——前端按登录态引导领赠送/充值/买断。
_NO_CREDIT_MSG = "额度不足：可领取赠送额度、充值，或买断后用自己的模型"


class BlockIn(BaseModel):
    id: str
    source: str | None = None  # 明文路径
    ct: str | None = None      # 加密路径（base64，AAD="src:"+id）


class TranslateRequest(BaseModel):
    blocks: list[BlockIn]
    localDate: str | None = None  # 用户本地日 YYYY-MM-DD（daily_usage 按本地日记账）


# ---- 依赖（测试可覆盖）----
def get_deepseek_stream():
    """返回 (api_key, blocks) -> async iter[str] 的上游流函数。"""
    return deepseek.stream_with_default_client


async def get_daily_usage() -> AsyncIterator[DailyUsageRepo]:
    async with async_session() as s:
        yield DailyUsageRepo(s)


async def get_credits() -> AsyncIterator[CreditRepo]:
    async with async_session() as s:
        yield CreditRepo(s)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/v1/translate")
async def translate_endpoint(
    req: TranslateRequest,
    request: Request,
    deepseek_stream=Depends(get_deepseek_stream),
    daily=Depends(get_daily_usage),
    credits=Depends(get_credits),
    user_id: int | None = Depends(current_user_optional),
):
    device_id = request.headers.get("x-device-id", "")
    local_date = req.localDate or date.today().isoformat()

    # D-13：带 X-Eph-Pub 头且服务端有私钥 → ECDH 派生会话密钥、解密原文 ct；否则走明文 source。
    # 握手/解密失败（被劫持改包、坏公钥、篡改 ct）→ 干净的 error 事件，而非 500。
    eph_pub = request.headers.get("x-eph-pub", "")
    enc_key = None
    enc_error = None
    if eph_pub and _server_priv:
        try:
            enc_key = crypto.derive_key(_server_priv, eph_pub)
            blocks = [SourceBlock(b.id, crypto.decrypt(enc_key, b.ct or "", f"src:{b.id}")) for b in req.blocks]
        except Exception:
            enc_error = "加密握手或解密失败，请重试"
            blocks = []
    else:
        blocks = [SourceBlock(b.id, b.source or "") for b in req.blocks]

    # 统一额度门控（走平台 key 的翻译）：owner = 注册用户 u:{id} 或未注册设备 d:{deviceId}。
    # 无 owner（既未登录又无 deviceId）或余额≤0 → 发 quota、不翻。BYOK 客户端直连不经此端点。
    owner = user_owner(user_id) if user_id is not None else (device_owner(device_id) if device_id else None)
    balance = await credits.get_balance(owner) if owner else 0
    no_credit = owner is None or balance <= 0

    async def gen() -> AsyncIterator[str]:
        if enc_error is not None:
            yield _sse("error", {"kind": "api", "message": enc_error})
            return
        if no_credit:
            yield _sse("quota", {"message": _NO_CREDIT_MSG, "balance": float(balance)})
            return
        async for ev in translate(
            blocks,
            deepseek_stream=deepseek_stream,
            api_key=settings.deepseek_api_key,
        ):
            if isinstance(ev, BlockEvent):
                if enc_key is not None:
                    yield _sse("block", {"id": ev.id, "ct": crypto.encrypt(enc_key, ev.translated, f"dst:{ev.id}")})
                else:
                    yield _sse("block", {"id": ev.id, "translated": ev.translated})
            elif isinstance(ev, UsageEvent):
                # 按实耗扣 owner 额度（成本价 ×1.3）。登录用户另记 daily_usage 作统计。
                await credits.deduct(owner, cost(ev.input_miss_tokens, ev.input_hit_tokens, ev.output_tokens))
                if user_id is not None:
                    await daily.add(user_id, local_date, ev.input_tokens, ev.output_tokens, pages=1)
            elif isinstance(ev, DoneEvent):
                yield _sse("done", {})
            elif isinstance(ev, ErrorEvent):
                yield _sse("error", {"kind": ev.kind, "message": ev.message})

    return StreamingResponse(gen(), media_type="text/event-stream")
