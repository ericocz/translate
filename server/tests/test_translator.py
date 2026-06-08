from app.services.cache import CacheHit
from app.services.translator import (
    BlockEvent,
    DoneEvent,
    SourceBlock,
    translate,
)


class FakeCache:
    def __init__(self, store: dict[str, CacheHit] | None = None):
        self.store = store or {}
        self.saved: list[dict] = []

    async def get_many(self, sources):
        return {s: self.store[s] for s in sources if s in self.store}

    async def set_many(self, entries):
        self.saved.extend(entries)


def fake_deepseek(scripted: dict[str, str]):
    """返回一个 deepseek_stream 替身：按块 id 直接吐 `[[id]] 译文`。"""
    async def _stream(api_key, blocks):
        for bid, _src in blocks:
            yield f"[[{bid}]] {scripted.get(bid, '')}"
    return _stream


async def drain(gen):
    return [ev async for ev in gen]


async def test_full_cache_hit_no_model_call():
    cache = FakeCache({"Hello": CacheHit("你好", 3, 2, 1)})
    called = False

    async def deepseek(api_key, blocks):
        nonlocal called
        called = True
        yield ""

    evs = await drain(translate(
        [SourceBlock("b1", "Hello")], cache=cache, deepseek_stream=deepseek, api_key="k",
    ))
    assert not called  # 全命中不调模型
    assert BlockEvent("b1", "你好") in evs
    assert any(isinstance(e, DoneEvent) for e in evs)


async def test_miss_calls_model_and_caches():
    cache = FakeCache()
    evs = await drain(translate(
        [SourceBlock("b1", "Hello")],
        cache=cache, deepseek_stream=fake_deepseek({"b1": "你好"}), api_key="k",
    ))
    assert BlockEvent("b1", "你好") in evs
    assert cache.saved and cache.saved[0]["translated"] == "你好"
    assert cache.saved[0]["input_tokens"] > 0  # 写缓存带 token 估算


async def test_dedupe_same_source_translated_once():
    cache = FakeCache()
    sent_batches = []

    async def deepseek(api_key, blocks):
        sent_batches.append([b[0] for b in blocks])
        for bid, _ in blocks:
            yield f"[[{bid}]] 提交"

    evs = await drain(translate(
        [SourceBlock("b1", "Submit"), SourceBlock("b2", "Submit")],
        cache=cache, deepseek_stream=deepseek, api_key="k",
    ))
    # 去重：只发一个代表块给模型，但两个 id 都收到译文
    assert sum(len(b) for b in sent_batches) == 1
    assert BlockEvent("b1", "提交") in evs and BlockEvent("b2", "提交") in evs


async def test_verbatim_echo_not_cached():
    cache = FakeCache()
    await drain(translate(
        [SourceBlock("b1", "OK")],
        cache=cache, deepseek_stream=fake_deepseek({"b1": "OK"}), api_key="k",
    ))
    assert cache.saved == []  # 原样回显不入缓存（自愈）


async def test_invalid_markers_not_cached_but_emitted():
    cache = FakeCache()
    # source 无标记，译文凭空冒出 <g0> → 校验失败 → 不缓存，但仍回送（客户端会再校验）
    evs = await drain(translate(
        [SourceBlock("b1", "Hello")],
        cache=cache, deepseek_stream=fake_deepseek({"b1": "<g0>你好</g0>"}), api_key="k",
    ))
    assert BlockEvent("b1", "<g0>你好</g0>") in evs
    assert cache.saved == []
