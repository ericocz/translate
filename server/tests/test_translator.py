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
    async def _stream(api_key, blocks):
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


async def test_dedupe_same_source_translated_once():
    sent_batches = []

    async def deepseek(api_key, blocks):
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
    async def ds(api_key, blocks):
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


async def test_normal_page_is_single_request():
    sent_batches: list[list[str]] = []

    async def deepseek(api_key, blocks):
        sent_batches.append([bid for bid, _ in blocks])
        for bid, _ in blocks:
            yield f"[[{bid}]] 译"

    # 30 个普通短块（远小于 OUTPUT_TOKEN_BUDGET）→ 必须只装一箱、只发一次
    blocks = [SourceBlock(f"b{i}", f"hello world {i}") for i in range(30)]
    await drain(translate(blocks, deepseek_stream=deepseek, api_key="k"))
    assert len(sent_batches) == 1
    assert len(sent_batches[0]) == 30
