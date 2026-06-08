import httpx
import pytest

from app.core.prompt import SYSTEM_PROMPT
from app.services.deepseek import (
    DeepSeekError,
    build_request_body,
    stream_content_deltas,
)


def test_request_body_locks_in_invariants():
    body = build_request_body([("b1", "Hello <g0>x</g0>")])
    assert body["model"] == "deepseek-v4-flash"
    assert body["stream"] is True
    assert body["thinking"] == {"type": "disabled"}         # 关思考
    assert body["messages"][0]["role"] == "system"
    assert body["messages"][0]["content"] == SYSTEM_PROMPT   # 稳定前缀逐字节
    assert body["messages"][1]["content"] == "[[b1]] Hello <g0>x</g0>"


def _sse(*contents: str) -> bytes:
    parts = ['data: {"choices":[{"delta":{"content":"%s"}}]}\n\n' % c for c in contents]
    parts.append("data: [DONE]\n\n")
    return "".join(parts).encode()


async def test_streams_content_deltas():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=_sse("[[b1]] ", "你好"))

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        got = [d async for d in stream_content_deltas(client, "sk-test", [("b1", "Hi")])]
    assert "".join(got) == "[[b1]] 你好"


async def test_401_raises_auth():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(DeepSeekError) as ei:
            [d async for d in stream_content_deltas(client, "bad", [("b1", "Hi")])]
    assert ei.value.kind == "auth"
