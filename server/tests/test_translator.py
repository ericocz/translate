from app.services.deepseek import Usage
from app.services.translator import (
    BlockEvent,
    DoneEvent,
    SourceBlock,
    UsageEvent,
    batch_by_token_budget,
    translate,
)


async def drain(gen):
    return [ev async for ev in gen]


def fake_deepseek(scripted: dict[str, str]):
    """deepseek_stream 替身：按块 id 直接吐 `[[id]] 译文`。"""
    async def _stream(api_key, blocks, *, target="zh"):
        for bid, _src in blocks:
            yield f"[[{bid}]] {scripted.get(bid, '')}"
    return _stream


async def test_translates_and_emits_block():
    evs = await drain(translate(
        [SourceBlock("b1", "Hello")],
        deepseek_stream=fake_deepseek({"b1": "你好"}), api_key="k",
    ))
    assert BlockEvent("b1", "你好") in evs
    assert any(isinstance(e, DoneEvent) for e in evs)


async def test_target_is_threaded_to_stream():
    seen = {}

    async def deepseek(api_key, blocks, *, target="zh"):
        seen["target"] = target
        for bid, _src in blocks:
            yield f"[[{bid}]] x"

    await drain(translate([SourceBlock("b1", "Hi")], deepseek_stream=deepseek, api_key="k", target="ja"))
    assert seen["target"] == "ja"


async def test_dedupe_same_source_translated_once():
    sent_batches = []

    async def deepseek(api_key, blocks, *, target="zh"):
        sent_batches.append([b[0] for b in blocks])
        for bid, _ in blocks:
            yield f"[[{bid}]] 提交"

    evs = await drain(translate(
        [SourceBlock("b1", "Submit"), SourceBlock("b2", "Submit")],
        deepseek_stream=deepseek, api_key="k",
    ))
    assert sum(len(b) for b in sent_batches) == 1  # 同 source 只发一个代表块
    assert BlockEvent("b1", "提交") in evs and BlockEvent("b2", "提交") in evs


async def test_invalid_markers_still_emitted():
    # source 无标记，译文凭空冒 <g0> → 校验失败但仍回送（客户端再校验）
    evs = await drain(translate(
        [SourceBlock("b1", "Hello")],
        deepseek_stream=fake_deepseek({"b1": "<g0>你好</g0>"}), api_key="k",
    ))
    assert BlockEvent("b1", "<g0>你好</g0>") in evs


async def test_usage_event_estimates_when_no_api_usage():
    # 接口没给 usage → est 兜底，input/output 估算 > 0
    evs = await drain(translate(
        [SourceBlock("b1", "Hello")],
        deepseek_stream=fake_deepseek({"b1": "你好世界"}), api_key="k",
    ))
    u = next(e for e in evs if isinstance(e, UsageEvent))
    assert u.input_tokens > 0 and u.output_tokens > 0


async def test_usage_event_from_model_real_usage():
    async def ds(api_key, blocks, *, target="zh"):
        for bid, _ in blocks:
            yield f"[[{bid}]] 你好"
        yield Usage(input_miss_tokens=30, input_hit_tokens=10, output_tokens=12)

    evs = await drain(translate([SourceBlock("b1", "Hi")], deepseek_stream=ds, api_key="k"))
    u = next(e for e in evs if isinstance(e, UsageEvent))
    # 真实 usage 优先于估算；输入按命中/未命中拆分透传
    assert u.input_miss_tokens == 30 and u.input_hit_tokens == 10 and u.output_tokens == 12
    assert u.input_tokens == 40  # 统计用总输入 = 命中 + 未命中


def _ids(batches):
    return [[bid for bid, _ in batch] for batch in batches]


def test_batch_empty():
    assert batch_by_token_budget([], 100) == []


def test_batch_all_under_budget_single_batch():
    blocks = [("b1", "hello"), ("b2", "world")]
    assert batch_by_token_budget(blocks, 1000) == [blocks]  # 全装一箱 → 一次请求


def test_batch_accumulates_until_budget():
    # 每块 "aaaaaaaa"(8 ASCII)=2 token；budget=5 → 每箱最多 2 块（2+2=4≤5，再+2=6>5）
    blocks = [(f"b{i}", "aaaaaaaa") for i in range(1, 6)]
    assert _ids(batch_by_token_budget(blocks, 5)) == [["b1", "b2"], ["b3", "b4"], ["b5"]]


def test_batch_single_oversized_block_alone():
    big = "a" * 400  # ceil(400/4)=100 token
    blocks = [("b1", "aaaa"), ("b2", big), ("b3", "aaaa")]  # 1,100,1 token；budget=10
    assert _ids(batch_by_token_budget(blocks, 10)) == [["b1"], ["b2"], ["b3"]]


async def test_blocks_stream_incrementally_not_buffered():
    # 回归守卫：切出一块即入队回送，绝不「整批流完再统一回送」——后者会让译文一次性涌出
    #（实测体感「一下子全部翻译完」）。这里在上游流还没结束时就应能取到首块。
    import asyncio

    release = asyncio.Event()

    async def ds(api_key, blocks, *, target="zh"):
        yield "[[b1]] 译一 [[b2]] "  # b1 已可切出（b2 标记到达）
        await release.wait()           # 卡住上游，模拟流未结束
        yield "译二"

    gen = translate(
        [SourceBlock("b1", "one"), SourceBlock("b2", "two")],
        deepseek_stream=ds, api_key="k",
    )
    first = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
    assert isinstance(first, BlockEvent) and first.id == "b1"  # 上游未结束就拿到首块
    release.set()
    rest = [ev async for ev in gen]
    assert BlockEvent("b2", "译二") in rest


async def test_small_page_single_batch():
    # 小页（总估算 < OUTPUT_TOKEN_BUDGET）仍只装一箱、只发一次——本就快，无需切。
    sent_batches: list[list[str]] = []

    async def deepseek(api_key, blocks, *, target="zh"):
        sent_batches.append([bid for bid, _ in blocks])
        for bid, _ in blocks:
            yield f"[[{bid}]] 译"

    blocks = [SourceBlock(f"b{i}", f"hello world {i}") for i in range(30)]
    await drain(translate(blocks, deepseek_stream=deepseek, api_key="k"))
    assert len(sent_batches) == 1
    assert len(sent_batches[0]) == 30


async def test_large_page_splits_into_parallel_batches():
    # 长页（总估算 >> 预算）按预算切多箱并发跑（响应速度优化）；每块仍各自回填、不丢块。
    sent_batches: list[list[str]] = []

    async def deepseek(api_key, blocks, *, target="zh"):
        sent_batches.append([bid for bid, _ in blocks])
        for bid, _ in blocks:
            yield f"[[{bid}]] 译"

    # 每块 source 各不相同（避免去重合并）、约 250 token → 40 块 ~10000 token >> 1500
    blocks = [SourceBlock(f"b{i}", "word " * 200 + f"uniq{i}") for i in range(40)]
    evs = await drain(translate(blocks, deepseek_stream=deepseek, api_key="k"))
    assert len(sent_batches) > 1  # 切了多箱
    got_ids = {ev.id for ev in evs if isinstance(ev, BlockEvent)}
    assert got_ids == {f"b{i}" for i in range(40)}  # 40 块全部回填
