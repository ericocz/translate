import httpx
import pytest

from app.core.prompt import SYSTEM_PROMPT
from app.services.deepseek import (
    MAX_OUTPUT_TOKENS,
    DeepSeekError,
    Usage,
    build_request_body,
    stream_content_deltas,
)


def test_request_body_locks_in_invariants():
    body = build_request_body([("b1", "Hello <g0>x</g0>")])
    assert body["model"] == "deepseek-v4-flash"
    assert body["stream"] is True
    assert body["thinking"] == {"type": "disabled"}         # 关思考
    assert body["stream_options"] == {"include_usage": True}  # 取真实 usage
    assert body["messages"][0]["role"] == "system"
    assert body["messages"][0]["content"] == SYSTEM_PROMPT   # 稳定前缀逐字节
    assert body["messages"][1]["content"] == "[[b1]] Hello <g0>x</g0>"


def test_request_body_sets_explicit_max_tokens():
    body = build_request_body([("b1", "hi")])
    # 显式设 max_tokens，令「超长被截断」行为确定；须 ≥ translator 的 OUTPUT_TOKEN_BUDGET(6500)
    assert body["max_tokens"] == MAX_OUTPUT_TOKENS
    assert MAX_OUTPUT_TOKENS >= 6500


def _sse(*contents: str) -> bytes:
    parts = ['data: {"choices":[{"delta":{"content":"%s"}}]}\n\n' % c for c in contents]
    parts.append('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\n')
    parts.append("data: [DONE]\n\n")
    return "".join(parts).encode()


async def test_streams_content_and_usage():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=_sse("[[b1]] ", "你好"))

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        items = [x async for x in stream_content_deltas(client, "sk-test", [("b1", "Hi")])]
    text = "".join(x for x in items if isinstance(x, str))
    usages = [x for x in items if isinstance(x, Usage)]
    assert text == "[[b1]] 你好"
    # 无 hit/miss 拆分字段 → 全算未命中（input_tokens = miss + hit = 12）
    assert usages and usages[0].input_tokens == 12 and usages[0].output_tokens == 7
    assert usages[0].input_miss_tokens == 12 and usages[0].input_hit_tokens == 0


async def test_usage_splits_cache_hit_miss():
    def _sse_split() -> bytes:
        return (
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
            'data: {"choices":[],"usage":{"prompt_tokens":12,"prompt_cache_hit_tokens":10,'
            '"prompt_cache_miss_tokens":2,"completion_tokens":7}}\n\n'
            "data: [DONE]\n\n"
        ).encode()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=_sse_split())

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = [x async for x in stream_content_deltas(client, "sk-test", [("b1", "Hi")])]
    u = next(x for x in items if isinstance(x, Usage))
    assert u.input_miss_tokens == 2 and u.input_hit_tokens == 10 and u.output_tokens == 7


async def test_401_raises_auth():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(DeepSeekError) as ei:
            [d async for d in stream_content_deltas(client, "bad", [("b1", "Hi")])]
    assert ei.value.kind == "auth"
