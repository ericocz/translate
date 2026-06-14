import asyncio
from dataclasses import dataclass
from typing import AsyncIterator, Callable, Protocol

from app.core.tokens import estimate_tokens
from app.services.block_splitter import BlockSplitter
from app.services.deepseek import Usage
from app.services.markers import (
    allowed_ids_from_source,
    is_verbatim_echo,
    validate_markers,
)

# 单请求「估算输出 token」预算：装箱上限，低于 deepseek.MAX_OUTPUT_TOKENS 留安全余量，
# 避免一次发太多块、输出超模型 max_tokens 被截断丢尾。正常文章整篇估算 < 此值 → 一次请求（D-12）。
OUTPUT_TOKEN_BUDGET = 6500
CONCURRENCY = 4


def batch_by_token_budget(
    blocks: list[tuple[str, str]], budget: int
) -> list[list[tuple[str, str]]]:
    """按估算输出 token 把 (id, source) 块顺序装箱，每箱累计 estimate_tokens(source) ≤ budget。

    - 译文与原文 token 量级相当，故用 estimate_tokens(source) 代理输出量；budget 已留安全余量。
    - 单块自身超 budget：独占一箱（块是原子的，拆块会破坏 <gN> 标记）。
    - 空输入 → []。
    """
    batches: list[list[tuple[str, str]]] = []
    current: list[tuple[str, str]] = []
    current_tokens = 0
    for bid, src in blocks:
        t = estimate_tokens(src)
        if current and current_tokens + t > budget:
            batches.append(current)
            current = []
            current_tokens = 0
        current.append((bid, src))
        current_tokens += t
    if current:
        batches.append(current)
    return batches


@dataclass(frozen=True)
class SourceBlock:
    id: str
    source: str


@dataclass(frozen=True)
class BlockEvent:
    id: str
    translated: str


@dataclass(frozen=True)
class DoneEvent:
    pass


@dataclass(frozen=True)
class ErrorEvent:
    kind: str
    message: str


@dataclass(frozen=True)
class UsageEvent:
    """本次请求应计入用户当日用量的 token 合计（命中读缓存 token + 未命中读真实 usage）。"""

    input_tokens: int
    output_tokens: int


Event = BlockEvent | DoneEvent | ErrorEvent | UsageEvent

# deepseek_stream(api_key, blocks) -> 逐个 yield content delta 文本
DeepSeekStream = Callable[[str, list[tuple[str, str]]], AsyncIterator[str]]


class CacheLike(Protocol):
    async def get_many(self, sources: list[str]) -> dict: ...
    async def set_many(self, entries: list[dict]) -> None: ...


async def translate(
    blocks: list[SourceBlock],
    *,
    cache: CacheLike,
    deepseek_stream: DeepSeekStream,
    api_key: str,
) -> AsyncIterator[Event]:
    """缓存优先 → 去重 → 分批 + 有限并发 → 切块 → 标记校验 → 写缓存。逐块 yield 事件。

    - 流式：每块译好即 yield（缓存命中同步、模型译出经 queue 合流）。
    - 失败隔离：单批失败不打断其余；只有「一块都没成功」才整体 ErrorEvent。
    - 原样回显 / 校验不过的块：仍回送（客户端再校验），但不写缓存（防缓存污染）。
    """
    if not blocks:
        yield DoneEvent()
        return

    # 1) 缓存优先：命中立即回送（缓存命中记账留待端点层处理 token）
    total_in = 0
    total_out = 0
    hit_map = await cache.get_many([b.source for b in blocks])
    misses: list[SourceBlock] = []
    for b in blocks:
        hit = hit_map.get(b.source)
        if hit is not None:
            yield BlockEvent(b.id, hit.translated)
            total_in += hit.input_tokens  # 缓存命中也记账
            total_out += hit.output_tokens
        else:
            misses.append(b)
    if not misses:
        yield UsageEvent(total_in, total_out)
        yield DoneEvent()
        return

    # 2) 按 source 去重：代表块发模型，译文广播给共享同 source 的所有 id
    by_source: dict[str, list[str]] = {}
    rep_source: dict[str, str] = {}  # rep_id -> source
    model_blocks: list[tuple[str, str]] = []
    for b in misses:
        if b.source in by_source:
            by_source[b.source].append(b.id)
            continue
        by_source[b.source] = [b.id]
        rep_source[b.id] = b.source
        model_blocks.append((b.id, b.source))

    # 3) 分批 + 有限并发，结果经 queue 合流回送
    batches = [model_blocks[i:i + BATCH_SIZE] for i in range(0, len(model_blocks), BATCH_SIZE)]
    queue: asyncio.Queue = asyncio.Queue()
    sem = asyncio.Semaphore(CONCURRENCY)
    to_cache: list[dict] = []
    success = 0
    last_error: ErrorEvent | None = None
    miss_in = 0
    miss_out = 0

    async def run_batch(batch: list[tuple[str, str]]) -> None:
        nonlocal success, last_error, miss_in, miss_out
        async with sem:
            collected: list[tuple[str, str]] = []
            splitter = BlockSplitter(lambda i, t: collected.append((i, t)))
            batch_usage: Usage | None = None
            try:
                async for item in deepseek_stream(api_key, batch):
                    if isinstance(item, Usage):
                        batch_usage = item  # 最后一块的真实用量
                    else:
                        splitter.feed(item)
                splitter.flush()
            except Exception as e:  # DeepSeekError 等：单批失败不打断其余
                last_error = ErrorEvent(getattr(e, "kind", "unknown"), getattr(e, "message", str(e)))
                return
            est_in = 0
            est_out = 0
            for rep_id, translated in collected:
                source = rep_source.get(rep_id)
                if source is None:
                    continue  # 模型乱编 id：忽略
                for bid in by_source[source]:
                    await queue.put(BlockEvent(bid, translated))
                # 用 source 反推 allowedIds 做与客户端等价的校验，只缓存合法且非回显的译文
                if validate_markers(translated, allowed_ids_from_source(source)).ok:
                    success += 1
                    if not is_verbatim_echo(source, translated):
                        ti = estimate_tokens(source)
                        to = estimate_tokens(translated)
                        to_cache.append({
                            "source": source,
                            "translated": translated,
                            "input_tokens": ti,
                            "output_tokens": to,
                        })
                        est_in += ti
                        est_out += to
            # 未命中记账：优先真实 usage；接口没给时回退到本地估算之和。
            if batch_usage is not None:
                miss_in += batch_usage.input_tokens
                miss_out += batch_usage.output_tokens
            else:
                miss_in += est_in
                miss_out += est_out

    async def producer() -> None:
        await asyncio.gather(*(run_batch(b) for b in batches))
        await queue.put(None)  # 哨兵：通知消费端结束

    task = asyncio.create_task(producer())
    while True:
        item = await queue.get()
        if item is None:
            break
        yield item
    await task

    await cache.set_many(to_cache)
    total_in += miss_in
    total_out += miss_out
    yield UsageEvent(total_in, total_out)
    # 全失败才报错；部分成功照常结束（未成功的块留待下次刷新按未命中重试）。
    if success == 0 and last_error is not None:
        yield last_error
    else:
        yield DoneEvent()
