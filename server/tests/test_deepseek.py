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
from app.services.translator import OUTPUT_TOKEN_BUDGET


def test_request_body_locks_in_invariants():
    body = build_request_body([("b1", "Hello <g0>x</g0>")])
    assert body["model"] == "deepseek-v4-flash"
    assert body["stream"] is True
    assert body["thinking"] == {"type": "disabled"}         # 关思考
    assert body["stream_options"] == {"include_usage": True}  # 取真实 usage
    assert body["messages"][0]["role"] == "system"
    assert body["messages"][0]["content"] == SYSTEM_PROMPT   # 稳定前缀逐字节
    assert body["messages"][1]["content"] == "[[b1]] Hello <g0>x</g0>"


def test_request_body_default_target_is_simplified_chinese():
    # 缺省 / target='zh' 仍用历史简体中文 prompt（逐字节不变，守前缀缓存）。
    assert build_request_body([("b1", "hi")])["messages"][0]["content"] == SYSTEM_PROMPT
    assert build_request_body([("b1", "hi")], target="zh")["messages"][0]["content"] == SYSTEM_PROMPT


def test_request_body_other_target_uses_generic_prompt_with_language_name():
    sys = build_request_body([("b1", "hi")], target="ja")["messages"][0]["content"]
    assert sys != SYSTEM_PROMPT
    assert "Japanese" in sys           # 注入目标语言英文名
    assert "[[id]]" in sys             # 输出格式规则保持（客户端切块依赖）
    assert "<g0>" in sys and "<x0/>" in sys  # 标记规则保持（标记校验依赖）


def test_request_body_traditional_chinese_is_generic_not_simplified():
    # zh-TW 走通用模板（英文名含 Traditional）→ 输出繁体，不复用简体专用 prompt。
    sys = build_request_body([("b1", "hi")], target="zh-TW")["messages"][0]["content"]
    assert sys != SYSTEM_PROMPT
    assert "Traditional" in sys


def test_request_body_sets_explicit_max_tokens():
    body = build_request_body([("b1", "hi")])
    # 显式设 max_tokens（截断硬顶），令「超长被截断」行为确定；须 ≥ translator 的 OUTPUT_TOKEN_BUDGET（装箱软上限）
    assert body["max_tokens"] == MAX_OUTPUT_TOKENS
    assert MAX_OUTPUT_TOKENS >= OUTPUT_TOKEN_BUDGET


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
