import json
from typing import AsyncIterator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core.config import settings
from app.db.base import async_session
from app.services import deepseek
from app.services.cache import TranslationCacheRepo
from app.services.translator import (
    BlockEvent,
    DoneEvent,
    ErrorEvent,
    SourceBlock,
    translate,
)

router = APIRouter()


class BlockIn(BaseModel):
    id: str
    source: str


class TranslateRequest(BaseModel):
    blocks: list[BlockIn]
    localDate: str | None = None  # P2 匿名配额用，本期忽略


# ---- 依赖（测试可覆盖）----
def get_deepseek_stream():
    """返回 (api_key, blocks) -> async iter[str] 的上游流函数。"""
    return deepseek.stream_with_default_client


async def get_cache() -> AsyncIterator[TranslationCacheRepo]:
    """每请求开一个 DB session，返回缓存仓库。yield 依赖在流式响应发完后才清理。"""
    async with async_session() as s:
        yield TranslationCacheRepo(s)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/v1/translate")
async def translate_endpoint(
    req: TranslateRequest,
    cache=Depends(get_cache),
    deepseek_stream=Depends(get_deepseek_stream),
):
    blocks = [SourceBlock(b.id, b.source) for b in req.blocks]

    async def gen() -> AsyncIterator[str]:
        async for ev in translate(
            blocks,
            cache=cache,
            deepseek_stream=deepseek_stream,
            api_key=settings.deepseek_api_key,
        ):
            if isinstance(ev, BlockEvent):
                yield _sse("block", {"id": ev.id, "translated": ev.translated})
            elif isinstance(ev, DoneEvent):
                yield _sse("done", {})
            elif isinstance(ev, ErrorEvent):
                yield _sse("error", {"kind": ev.kind, "message": ev.message})

    return StreamingResponse(gen(), media_type="text/event-stream")
