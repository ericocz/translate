"""跨 provider failover：官方 DeepSeek 主 + 火山方舟备。

通过 monkeypatch `stream_content_deltas`（按 url 区分主/备）驱动 `stream_with_failover`，
不打真实网络。"""
import pytest

from app.services import deepseek
from app.services.deepseek import DeepSeekError, Usage

ARK_URL = "https://ark.test/api/v3/chat/completions"


@pytest.fixture
def volc_configured(monkeypatch):
    monkeypatch.setattr(deepseek.settings, "volcengine_api_key", "ark-key")
    monkeypatch.setattr(deepseek.settings, "volcengine_model", "ep-volc")
    monkeypatch.setattr(deepseek.settings, "volcengine_base_url", "https://ark.test/api/v3")


def _patch_scd(monkeypatch, behavior):
    async def fake(client, api_key, blocks, *, url, model, target="zh"):
        async for item in behavior(url):
            yield item
    monkeypatch.setattr(deepseek, "stream_content_deltas", fake)


async def _drain(blocks="b"):
    out = []
    async for item in deepseek.stream_with_failover("primary-key", [("b1", "Hi")]):
        out.append(item)
    return out


async def test_no_failover_when_unconfigured(monkeypatch):
    # 没配火山 → 只有官方一路；官方失败直接抛
    monkeypatch.setattr(deepseek.settings, "volcengine_api_key", "")

    async def behavior(url):
        raise DeepSeekError("api", "official 5xx")
        yield  # pragma: no cover

    _patch_scd(monkeypatch, behavior)
    with pytest.raises(DeepSeekError):
        await _drain()


async def test_fails_over_to_volcengine_before_content(monkeypatch, volc_configured):
    # 官方首 token 前失败 → 切火山，吐火山内容、不抛
    async def behavior(url):
        if url == deepseek.DEEPSEEK_URL:
            raise DeepSeekError("network", "official down")
        # 火山备线
        yield "你好"
        yield Usage(input_miss_tokens=5, input_hit_tokens=0, output_tokens=3)

    _patch_scd(monkeypatch, behavior)
    out = await _drain()
    assert "你好" in out and any(isinstance(x, Usage) for x in out)


async def test_no_failover_after_content_yielded(monkeypatch, volc_configured):
    # 官方已吐内容后才失败 → 不换源，原样抛（避免半句重来）
    async def behavior(url):
        if url == deepseek.DEEPSEEK_URL:
            yield "半"
            raise DeepSeekError("network", "mid-stream drop")
        yield "不该用到火山"  # pragma: no cover

    _patch_scd(monkeypatch, behavior)
    collected = []
    with pytest.raises(DeepSeekError):
        async for item in deepseek.stream_with_failover("k", [("b1", "Hi")]):
            collected.append(item)
    assert collected == ["半"]


async def test_primary_success_skips_volcengine(monkeypatch, volc_configured):
    seen_urls = []

    async def behavior(url):
        seen_urls.append(url)
        yield "你好"

    _patch_scd(monkeypatch, behavior)
    out = await _drain()
    assert out == ["你好"] and seen_urls == [deepseek.DEEPSEEK_URL]  # 没碰火山
