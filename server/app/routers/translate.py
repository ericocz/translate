import json
from dataclasses import dataclass
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
from app.services.pricing import cost_for

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
    target: str | None = None     # 目标语言代码（如 zh / ja / en-US）；缺省按简体中文翻


# ---- 依赖（测试可覆盖）----
def get_deepseek_stream():
    """返回 (api_key, blocks) -> async iter[str] 的上游流函数（官方主 + 火山备 failover）。"""
    return deepseek.stream_with_failover


async def get_daily_usage() -> AsyncIterator[DailyUsageRepo]:
    async with async_session() as s:
        yield DailyUsageRepo(s)


async def get_credits() -> AsyncIterator[CreditRepo]:
    async with async_session() as s:
        yield CreditRepo(s)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@dataclass
class _Prepared:
    """一次翻译请求的预处理结果（解密 + 额度门控），SSE / 非流式两端共用。"""

    blocks: list[SourceBlock]
    enc_key: bytes | None
    enc_error: str | None
    owner: str | None
    bucket: str | None       # 本次扣费桶（优先级最高且 >0），None=无任何余额
    currency: str | None     # 该桶币种（CNY/USD），决定三档价用 ¥ 还是 $
    no_credit: bool
    local_date: str
    target: str              # 目标语言代码（决定系统提示词）；缺省 'zh'


async def _prepare(req: TranslateRequest, request: Request, credits, user_id: int | None) -> _Prepared:
    """解密原文（如有）+ 定位 owner + 查余额。两个端点（流式/非流式）共用。"""
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
    # 按优先级取扣费桶（赠送¥ → 充值¥ → 充值$）；无 owner 或三桶全空 → 发 quota、不翻。
    # 本次请求内桶固定一次（避免请求内跨桶切换的分摊复杂）：用该桶币种三档价扣该桶，不做汇率换算。
    owner = user_owner(user_id) if user_id is not None else (device_owner(device_id) if device_id else None)
    active = await credits.active_bucket(owner) if owner else None
    bucket, currency = active if active else (None, None)
    no_credit = active is None
    target = (req.target or "zh").strip() or "zh"
    return _Prepared(blocks, enc_key, enc_error, owner, bucket, currency, no_credit, local_date, target)


async def _translate_frames(
    prep: _Prepared,
    *,
    user_id: int | None,
    deepseek_stream,
    credits,
    daily,
) -> AsyncIterator[tuple[str, dict]]:
    """产出 (事件名, 数据) 帧并就地扣费——SSE 端序列化为 event:/data:，非流式端收集为 JSON。

    保证两端语义逐字一致（门控、加密、扣费、记账、错误分类只此一份）。
    """
    if prep.enc_error is not None:
        yield "error", {"kind": "api", "message": prep.enc_error}
        return
    if prep.no_credit:
        yield "quota", {"message": _NO_CREDIT_MSG, "balance": 0}
        return
    async for ev in translate(
        prep.blocks,
        deepseek_stream=deepseek_stream,
        api_key=settings.deepseek_api_key,
        target=prep.target,
    ):
        if isinstance(ev, BlockEvent):
            if prep.enc_key is not None:
                yield "block", {"id": ev.id, "ct": crypto.encrypt(prep.enc_key, ev.translated, f"dst:{ev.id}")}
            else:
                yield "block", {"id": ev.id, "translated": ev.translated}
        elif isinstance(ev, UsageEvent):
            # 按实耗扣 owner 当前桶额度：用该桶币种三档价（¥ 或 $）×1.3。登录用户另记 daily_usage 作统计。
            await credits.deduct(
                prep.owner,
                cost_for(prep.currency, ev.input_miss_tokens, ev.input_hit_tokens, ev.output_tokens),
                bucket=prep.bucket,
            )
            if user_id is not None:
                await daily.add(user_id, prep.local_date, ev.input_tokens, ev.output_tokens, pages=1)
        elif isinstance(ev, DoneEvent):
            yield "done", {}
        elif isinstance(ev, ErrorEvent):
            yield "error", {"kind": ev.kind, "message": ev.message}


@router.post("/v1/translate")
async def translate_endpoint(
    req: TranslateRequest,
    request: Request,
    deepseek_stream=Depends(get_deepseek_stream),
    daily=Depends(get_daily_usage),
    credits=Depends(get_credits),
    user_id: int | None = Depends(current_user_optional),
):
    """正文翻译：SSE 流式，逐块即时回送（首屏「秒懂」）。"""
    prep = await _prepare(req, request, credits, user_id)

    async def gen() -> AsyncIterator[str]:
        async for name, data in _translate_frames(
            prep, user_id=user_id, deepseek_stream=deepseek_stream, credits=credits, daily=daily
        ):
            yield _sse(name, data)

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/v1/translate/batch")
async def translate_batch_endpoint(
    req: TranslateRequest,
    request: Request,
    deepseek_stream=Depends(get_deepseek_stream),
    daily=Depends(get_daily_usage),
    credits=Depends(get_credits),
    user_id: int | None = Depends(current_user_optional),
):
    """非正文翻译（外框 / 重试）：普通 HTTP，一次性收完全部块返 JSON。

    外框（导航/页脚）量小且不在用户视线焦点，重试是带上下文的小整批——都不需要流式逐块淡入的
    首屏体感，故走非流式：少一条长连接、客户端解析更简单。门控/加密/扣费与 SSE 端逐字共用。
    返回 {blocks:[{id,translated}|{id,ct}], error?, quota?}。
    """
    prep = await _prepare(req, request, credits, user_id)
    out_blocks: list[dict] = []
    error: dict | None = None
    quota: dict | None = None
    async for name, data in _translate_frames(
        prep, user_id=user_id, deepseek_stream=deepseek_stream, credits=credits, daily=daily
    ):
        if name == "block":
            out_blocks.append(data)
        elif name == "error":
            error = data
        elif name == "quota":
            quota = data
        # "done" 隐含于无 error/quota，不单列字段。
    resp: dict = {"blocks": out_blocks}
    if error is not None:
        resp["error"] = error
    if quota is not None:
        resp["quota"] = quota
    return resp
