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
from app.services.quota import AnonQuotaRepo
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
from app.services.tier_repo import TierRepo

router = APIRouter()

# D-13 应用层加密：静态私钥启动时载一次；空＝明文路径（dev / 现有测试）。
_server_priv = crypto.load_private_key(settings.session_private_key) if settings.session_private_key else None


class BlockIn(BaseModel):
    id: str
    source: str | None = None  # 明文路径
    ct: str | None = None      # 加密路径（base64，AAD="src:"+id）


class TranslateRequest(BaseModel):
    blocks: list[BlockIn]
    localDate: str | None = None  # 用户本地日 YYYY-MM-DD（匿名配额按本地日跨天重置）
    pageKey: str | None = None    # 客户端算好的页面身份哈希（匿名「每页一次」）


# ---- 依赖（测试可覆盖）----
def get_deepseek_stream():
    """返回 (api_key, blocks) -> async iter[str] 的上游流函数。"""
    return deepseek.stream_with_default_client


async def get_anon_quota() -> AsyncIterator[AnonQuotaRepo]:
    """每请求开一个 DB session，返回匿名配额仓库。"""
    async with async_session() as s:
        yield AnonQuotaRepo(s)


async def get_daily_usage() -> AsyncIterator[DailyUsageRepo]:
    async with async_session() as s:
        yield DailyUsageRepo(s)


async def get_tier() -> AsyncIterator[TierRepo]:
    async with async_session() as s:
        yield TierRepo(s)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/v1/translate")
async def translate_endpoint(
    req: TranslateRequest,
    request: Request,
    quota=Depends(get_anon_quota),
    deepseek_stream=Depends(get_deepseek_stream),
    daily=Depends(get_daily_usage),
    tier=Depends(get_tier),
    user_id: int | None = Depends(current_user_optional),
):
    device_id = request.headers.get("x-device-id", "")
    ip = request.client.host if request.client else None
    local_date = req.localDate or date.today().isoformat()

    # D-13：带 X-Eph-Pub 头且服务端有私钥 → ECDH 派生会话密钥、解密原文 ct；否则走明文 source。
    eph_pub = request.headers.get("x-eph-pub", "")
    enc_key = crypto.derive_key(_server_priv, eph_pub) if (eph_pub and _server_priv) else None
    if enc_key is not None:
        blocks = [SourceBlock(b.id, crypto.decrypt(enc_key, b.ct or "", f"src:{b.id}")) for b in req.blocks]
    else:
        blocks = [SourceBlock(b.id, b.source or "") for b in req.blocks]

    # 匿名配额闸门（P2；P3 登录用户将在此跳过）。有 pageKey + deviceId 才计。
    # 在返回流之前 await 完成判定/计数；拒绝则流里只发 quota、不查缓存不调模型。
    # 登录用户（user_id 非空）跳过匿名配额：无限翻译（用量记账留 P4、限流留 P5）。
    decision = None
    if user_id is None and req.pageKey and device_id:
        decision = await quota.check_and_count(device_id, local_date, req.pageKey, ip)

    # 登录用户：梯度限流（固定日 Token 上限分档）。超限即拦截并提醒。
    tier_block_msg = None
    if user_id is not None:
        tev = await tier.evaluate(user_id, local_date)
        if not tev.allowed:
            tier_block_msg = tev.notice

    async def gen() -> AsyncIterator[str]:
        if decision is not None and not decision.allowed:
            yield _sse("quota", {
                "message": decision.message,
                "used": decision.used,
                "limit": decision.limit,
            })
            return
        if tier_block_msg is not None:
            yield _sse("quota", {"message": tier_block_msg})
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
                # 登录用户记当日 token（只计服务端实际翻译的用量）；匿名不记 daily_usage（走页配额）。
                if user_id is not None:
                    await daily.add(user_id, local_date, ev.input_tokens, ev.output_tokens, pages=1)
            elif isinstance(ev, DoneEvent):
                yield _sse("done", {})
            elif isinstance(ev, ErrorEvent):
                yield _sse("error", {"kind": ev.kind, "message": ev.message})

    return StreamingResponse(gen(), media_type="text/event-stream")
